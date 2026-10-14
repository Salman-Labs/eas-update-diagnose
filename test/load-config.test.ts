import { describe, expect, it } from 'vitest';
import { loadProject } from '../src/load-config.js';
import { tempProject } from './helpers.js';

describe('loadProject', () => {
  it('loads a static app.json and eas.json profiles, including extends', async () => {
    const root = tempProject({
      'app.json': JSON.stringify({
        expo: {
          name: 'Static',
          version: '1.0.0',
          runtimeVersion: '1.0.0',
          updates: { url: 'https://u.expo.dev/11111111-2222-4333-8444-555555555555' },
        },
      }),
      'eas.json': JSON.stringify({
        build: {
          base: { channel: 'production' },
          production: { extends: 'base' },
          preview: { extends: 'base', channel: 'preview' },
        },
      }),
      'package.json': JSON.stringify({ dependencies: { 'expo-updates': '1.0.0' } }),
    });
    const loaded = await loadProject(root);
    expect(loaded.expo?.name).toBe('Static');
    expect(loaded.profiles.map((profile) => [profile.name, profile.channel])).toEqual([
      ['base', 'production'],
      ['production', 'production'],
      ['preview', 'preview'],
    ]);
    expect(loaded.expoUpdatesInstalled).toBe(true);
  });

  it('evaluates app.config.js with the static config and prefers it over app.json', async () => {
    const root = tempProject({
      'package.json': JSON.stringify({ name: 'cjs-app', type: 'commonjs' }),
      'app.json': JSON.stringify({ expo: { name: 'FromJson', slug: 'from-json', version: '3.1.0' } }),
      'app.config.js': `module.exports = ({ config }) => ({
        ...config,
        runtimeVersion: { policy: 'appVersion' },
        updates: { url: 'https://updates.example.com/manifest' },
      });
`,
    });
    const loaded = await loadProject(root);
    expect(loaded.appConfigPath).toMatch(/app\.config\.js$/);
    expect(loaded.expo).toMatchObject({
      name: 'FromJson',
      version: '3.1.0',
      runtimeVersion: { policy: 'appVersion' },
      updates: { url: 'https://updates.example.com/manifest' },
    });
  });

  it('evaluates app.config.ts and app.config.mjs', async () => {
    const tsRoot = tempProject({
      'package.json': JSON.stringify({ private: true }),
      'app.config.ts': `import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'FromTs',
  slug: 'from-ts',
  version: '2.0.0',
  runtimeVersion: { policy: 'appVersion' },
  updates: { url: 'https://updates.example.com/manifest' },
};

export default config;
`,
    });
    const tsLoaded = await loadProject(tsRoot);
    expect(tsLoaded.loadError).toBeNull();
    expect(tsLoaded.expo).toMatchObject({ name: 'FromTs', version: '2.0.0' });

    const mjsRoot = tempProject({
      'package.json': JSON.stringify({ type: 'module' }),
      'app.config.mjs': `export default { name: 'FromMjs', slug: 'from-mjs', runtimeVersion: '8' };\n`,
    });
    const mjsLoaded = await loadProject(mjsRoot);
    expect(mjsLoaded.expo).toMatchObject({ name: 'FromMjs', runtimeVersion: '8' });
  });

  it('prefers app.config.json over app.json and reads the expo key from package.json', async () => {
    const jsonRoot = tempProject({
      'app.json': JSON.stringify({ expo: { name: 'AppJson' } }),
      'app.config.json': JSON.stringify({ expo: { name: 'AppConfigJson', runtimeVersion: '1' } }),
    });
    expect((await loadProject(jsonRoot)).expo?.name).toBe('AppConfigJson');

    const pkgRoot = tempProject({
      'package.json': JSON.stringify({ expo: { name: 'FromPackage', runtimeVersion: '4' } }),
    });
    expect((await loadProject(pkgRoot)).expo?.name).toBe('FromPackage');
  });

  it('reports a profile cycle and a missing config', async () => {
    const cycle = tempProject({
      'app.json': JSON.stringify({ expo: { name: 'Cycle' } }),
      'eas.json': JSON.stringify({ build: { a: { extends: 'b' }, b: { extends: 'a' } } }),
    });
    const loaded = await loadProject(cycle);
    expect(loaded.easError?.code).toBe('EAS_JSON_INVALID');
    expect(loaded.easError?.message).toMatch(/cycle/);

    const missing = await loadProject(tempProject({ 'readme.txt': 'no config' }));
    expect(missing.loadError?.code).toBe('APP_CONFIG_MISSING');
  });
});
