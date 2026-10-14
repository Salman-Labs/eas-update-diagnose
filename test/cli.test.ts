import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';
import { capture, tempProject } from './helpers.js';
import type { Diagnosis } from '../src/types.js';

const execFileAsync = promisify(execFile);

describe('cli', () => {
  it('parses the documented flags', () => {
    const args = parseArgs([
      '--from-project',
      'fixtures/stuck',
      '--profile',
      'production',
      '--platform=ios',
      '--channel',
      'production',
      '--runtime-version',
      '1.2.1',
      '--fetch-manifest',
      '--manifest-timeout',
      '1500',
      '--json',
      '--ci',
    ]);
    expect(args).toMatchObject({
      fromProject: 'fixtures/stuck',
      profiles: ['production'],
      platforms: ['ios'],
      channels: ['production'],
      runtimeVersion: '1.2.1',
      fetchManifest: true,
      manifestTimeoutMs: 1500,
      json: true,
      ci: true,
    });
  });

  it('prints help and rejects unknown input', async () => {
    const help = await capture(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--from-project');
    expect(help.stdout).toContain('--fetch-manifest');
    expect(help.stdout).toContain('not affiliated with Expo');

    const version = await capture(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toContain('eas-update-diagnose 0.1.0');

    const unknown = await capture(['--from-project', '.', '--not-a-flag']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/Unknown option/);

    const missing = await capture(['--from-project', 'fixtures/does-not-exist']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/not found/);
  });

  it('exits 0 without --ci and 1 with --ci when the checklist fails', async () => {
    const report = await capture(['--from-project', 'fixtures/stuck']);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain('FAIL  RUNTIME_MISMATCH');
    expect(report.stdout).toContain('FAIL  CHANNEL_UNMAPPED');
    expect(report.stdout).toContain('FAIL  PLAY_TRANSLATION_HINT');
    expect(report.stdout).toContain('https://github.com/expo/expo/issues/48148');

    const ci = await capture(['--from-project', 'fixtures/stuck', '--ci']);
    expect(ci.code).toBe(1);

    const healthy = await capture(['--from-project', 'fixtures/healthy', '--ci', '--json']);
    expect(healthy.code).toBe(0);
    const parsed = JSON.parse(healthy.stdout) as Diagnosis;
    expect(parsed.ok).toBe(true);
    expect(parsed.tool).toBe('eas-update-diagnose');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.summary.fail).toBe(0);
    expect(parsed.summary.warn).toBe(1);
    expect(parsed.profiles.map((profile) => profile.channel)).toEqual(['development', 'preview', 'production']);
  });

  it('runs the built binary against the fixture project', async () => {
    const { stdout } = await execFileAsync('node', ['dist/cli.js', '--from-project', 'fixtures/healthy', '--version']);
    expect(stdout).toContain('0.1.0');
    const stuck = await execFileAsync('node', ['dist/cli.js', '--from-project', 'fixtures/stuck', '--ci', '--json'], {
      encoding: 'utf8',
    }).then(
      () => ({ code: 0, stdout: '', stderr: '' }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({
        code: err.code ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      }),
    );
    expect(stuck.code).toBe(1);
    const parsed = JSON.parse(stuck.stdout) as Diagnosis;
    expect(parsed.checks.some((check) => check.code === 'UPDATES_URL_MISSING')).toBe(false);
    expect(parsed.checks.some((check) => check.status === 'fail' && check.code === 'RUNTIME_MISMATCH')).toBe(true);
  });

  it('fetch-manifest from the CLI talks to the updates url', async () => {
    const requests: Array<{ platform?: string | string[]; runtime?: string | string[]; channel?: string | string[] }> = [];
    const server = createServer((req, res) => {
      requests.push({
        platform: req.headers['expo-platform'],
        runtime: req.headers['expo-runtime-version'],
        channel: req.headers['expo-channel-name'],
      });
      const boundary = 'diag';
      const body = [
        `--${boundary}`,
        'content-type: application/json',
        '',
        JSON.stringify({ id: 'upd_cli', runtimeVersion: '1.4.0', assets: [], launchAsset: { key: 'bundle' } }),
        `--${boundary}--`,
        '',
      ].join('\r\n');
      res.writeHead(200, { 'content-type': `multipart/mixed; boundary=${boundary}` });
      res.end(body);
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    try {
      const root = tempProject({
        'app.json': JSON.stringify({
          expo: {
            name: 'Fetch',
            version: '1.4.0',
            platforms: ['ios'],
            runtimeVersion: { policy: 'appVersion' },
            updates: { url: `http://127.0.0.1:${port}/manifest` },
          },
        }),
        'eas.json': JSON.stringify({ build: { production: { channel: 'production' } } }),
        'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
      });
      const result = await capture([
        '--from-project',
        root,
        '--fetch-manifest',
        '--platform',
        'ios',
        '--json',
        '--ci',
      ]);
      expect(result.code).toBe(0);
      expect(requests).toEqual([{ platform: 'ios', runtime: '1.4.0', channel: 'production' }]);
      const parsed = JSON.parse(result.stdout) as Diagnosis;
      expect(parsed.manifests[0]?.updateId).toBe('upd_cli');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
