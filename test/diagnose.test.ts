import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';
import { formatReport } from '../src/report.js';
import { tempProject, codes } from './helpers.js';

const projectId = '11111111-2222-4333-8444-555555555555';

function appConfig(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    expo: {
      name: 'App',
      slug: 'app',
      version: '1.4.0',
      runtimeVersion: { policy: 'appVersion' },
      updates: { url: `https://u.expo.dev/${projectId}` },
      extra: { eas: { projectId } },
      ios: { buildNumber: '12' },
      android: { versionCode: 12 },
      ...extra,
    },
  });
}

describe('diagnose', () => {
  it('passes the healthy fixture except for the Play translation warning', async () => {
    const diagnosis = await diagnose({ projectRoot: 'fixtures/healthy' });
    expect(diagnosis.ok).toBe(true);
    expect(diagnosis.resolvedRuntime).toEqual({ ios: '1.4.0', android: '1.4.0' });
    expect(codes(diagnosis.checks, 'fail')).toEqual([]);
    expect(codes(diagnosis.checks, 'warn')).toEqual(['PLAY_TRANSLATION_HINT']);
    expect(diagnosis.checks.find((check) => check.code === 'PLAY_TRANSLATION_HINT')?.message).toContain(
      'https://github.com/expo/expo/issues/48148',
    );
    expect(formatReport(diagnosis, false)).toContain('result  PASS');
  });

  it('reports the stuck fixture reason codes', async () => {
    const diagnosis = await diagnose({ projectRoot: 'fixtures/stuck' });
    expect(diagnosis.ok).toBe(false);
    const failed = codes(diagnosis.checks, 'fail');
    expect(failed).toContain('RUNTIME_MISMATCH');
    expect(failed).toContain('CHANNEL_UNMAPPED');
    expect(failed).toContain('PLAY_TRANSLATION_HINT');
    const runtime = diagnosis.checks.find((check) => check.code === 'RUNTIME_MISMATCH');
    expect(runtime?.message).toContain('1.2.1');
    expect(runtime?.message).toContain('1.4.0');
    expect(runtime?.platform).toBe('ios');
    const preview = diagnosis.checks.find((check) => check.code === 'CHANNEL_UNMAPPED' && check.profile === 'preview');
    expect(preview?.status).toBe('fail');
    const development = diagnosis.checks.find((check) => check.code === 'CHANNEL_UNMAPPED' && check.profile === 'development');
    expect(development?.status).toBe('warn');
    const play = diagnosis.checks.find((check) => check.code === 'PLAY_TRANSLATION_HINT' && check.status === 'fail');
    expect(play?.message).toContain('values-el');
    expect(play?.message).toContain('1.2.1');
    const text = formatReport(diagnosis, false);
    expect(text).toMatch(/FAIL\s+RUNTIME_MISMATCH/);
    expect(text).toMatch(/FAIL\s+CHANNEL_UNMAPPED/);
    expect(text).toMatch(/FAIL\s+PLAY_TRANSLATION_HINT/);
  });

  it('flags a missing updates url, a disabled client, and a project id mismatch', async () => {
    const missingUrl = await diagnose({
      projectRoot: tempProject({
        'app.json': JSON.stringify({
          expo: { name: 'NoUrl', version: '1.0.0', runtimeVersion: '1.0.0' },
        }),
        'eas.json': JSON.stringify({ build: { production: { channel: 'production' } } }),
        'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
      }),
    });
    expect(codes(missingUrl.checks, 'fail')).toContain('UPDATES_URL_MISSING');

    const disabled = await diagnose({
      projectRoot: tempProject({
        'app.json': appConfig({ updates: { enabled: false, url: `https://u.expo.dev/${projectId}` } }),
        'eas.json': JSON.stringify({ build: { production: { channel: 'production' } } }),
        'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
      }),
    });
    expect(codes(disabled.checks, 'fail')).toContain('UPDATES_DISABLED');

    const mismatch = await diagnose({
      projectRoot: tempProject({
        'app.json': appConfig({ extra: { eas: { projectId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } } }),
        'eas.json': JSON.stringify({ build: { production: { channel: 'production' } } }),
        'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
      }),
    });
    expect(codes(mismatch.checks, 'fail')).toContain('PROJECT_ID_MISMATCH');
    expect(codes(mismatch.checks, 'fail')).not.toContain('EXPO_UPDATES_MISSING');

    const bare = await diagnose({
      projectRoot: tempProject({
        'app.json': appConfig(),
        'eas.json': JSON.stringify({ build: { production: { channel: 'production' } } }),
        'package.json': JSON.stringify({ name: 'no-updates' }),
      }),
    });
    expect(codes(bare.checks, 'fail')).toContain('EXPO_UPDATES_MISSING');
  });

  it('flags a platform that the app config does not ship and a native runtime split', async () => {
    const platform = await diagnose({
      projectRoot: tempProject({
        'app.json': appConfig({ platforms: ['ios'] }),
        'eas.json': JSON.stringify({ build: { production: { channel: 'production' } } }),
        'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
      }),
      platforms: ['android'],
    });
    expect(codes(platform.checks, 'fail')).toContain('PLATFORM_MISSING');

    const native = await diagnose({
      projectRoot: tempProject({
        'app.json': JSON.stringify({
          expo: {
            name: 'Split',
            version: '1.0.0',
            runtimeVersion: { policy: 'nativeVersion' },
            updates: { url: 'https://updates.example.com/manifest' },
            ios: { buildNumber: '2' },
            android: { versionCode: 9 },
          },
        }),
        'eas.json': JSON.stringify({ build: { production: { channel: 'production' } } }),
        'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
      }),
    });
    expect(native.resolvedRuntime).toEqual({ ios: '1.0.0(2)', android: '1.0.0(9)' });
    expect(codes(native.checks, 'fail')).toContain('RUNTIME_MISMATCH');
  });

  it('compares a device runtime and a native embedded runtime', async () => {
    const root = tempProject({
      'app.json': appConfig(),
      'eas.json': JSON.stringify({ build: { production: { channel: 'production' } } }),
      'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
      'ios/App/Supporting/Expo.plist': `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>EXUpdatesRuntimeVersion</key><string>1.4.0</string>
  <key>EXUpdatesURL</key><string>https://u.expo.dev/${projectId}</string>
  <key>EXUpdatesRequestHeaders</key><dict><key>expo-channel-name</key><string>staging</string></dict>
</dict></plist>`,
    });
    const diagnosis = await diagnose({ projectRoot: root, runtimeVersion: '1.2.1' });
    const device = diagnosis.checks.filter((check) => check.code === 'RUNTIME_MISMATCH' && check.message.includes('Device runtime'));
    expect(device.map((check) => check.platform).sort()).toEqual(['android', 'ios']);
    expect(codes(diagnosis.checks, 'fail')).toContain('CHANNEL_HEADER_MISMATCH');
  });

  it('fetches the manifest with the protocol headers', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = await listen((req, res) => {
      seen.push(req.headers);
      if (req.headers['expo-platform'] === 'ios') {
        res.writeHead(200, { 'content-type': 'application/expo+json' });
        res.end(JSON.stringify({ id: 'upd_ok', runtimeVersion: '1.4.0', launchAsset: { key: 'bundle' }, assets: [] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'No compatible update found' }));
    });
    try {
      const root = tempProject({
        'app.json': appConfig({ updates: { url: server.url } }),
        'eas.json': JSON.stringify({
          build: { production: { channel: 'production' }, preview: { channel: 'preview' } },
        }),
        'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
      });
      const ok = await diagnose({
        projectRoot: root,
        platforms: ['ios'],
        profiles: ['production'],
        fetchManifest: true,
        fetchImpl: fetch,
      });
      expect(ok.manifests).toHaveLength(1);
      expect(ok.manifests[0]).toMatchObject({
        platform: 'ios',
        channel: 'production',
        runtimeVersion: '1.4.0',
        httpStatus: 200,
        updateId: 'upd_ok',
      });
      expect(seen[0]).toMatchObject({
        'expo-platform': 'ios',
        'expo-runtime-version': '1.4.0',
        'expo-channel-name': 'production',
        'expo-protocol-version': '1',
      });
      expect(codes(ok.checks, 'fail')).not.toContain('MANIFEST_NO_UPDATE');
      expect(codes(ok.checks, 'pass')).toContain('MANIFEST');

      seen.length = 0;
      const missing = await diagnose({
        projectRoot: root,
        platforms: ['android'],
        channels: ['preview'],
        fetchManifest: true,
        fetchImpl: fetch,
      });
      expect(codes(missing.checks, 'fail')).toContain('MANIFEST_NO_UPDATE');
      expect(seen[0]?.['expo-platform']).toBe('android');
      expect(seen[0]?.['expo-channel-name']).toBe('preview');
    } finally {
      await close(server.server);
    }
  });

  it('does not depend on eas-cli', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names).not.toContain('eas-cli');
    const sources = readdirSync('src').filter((name) => name.endsWith('.ts'));
    for (const name of sources) {
      expect(readFileSync(`src/${name}`, 'utf8')).not.toMatch(/from ['"]eas-cli|require\(['"]eas-cli/);
    }
  });
});

function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({ url: `http://127.0.0.1:${address.port}/manifest`, server });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
