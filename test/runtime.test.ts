import { describe, expect, it } from 'vitest';
import { resolveRuntime } from '../src/runtime.js';
import type { ExpoConfig } from '../src/types.js';

const base: ExpoConfig = {
  version: '1.4.0',
  ios: { buildNumber: '12' },
  android: { versionCode: 12 },
};

describe('resolveRuntime', () => {
  it('keeps a fixed runtime version', () => {
    expect(resolveRuntime('2024.10.1', base, 'ios')).toEqual({ value: '2024.10.1', policy: null, reason: null });
  });

  it('resolves appVersion from expo.version', () => {
    expect(resolveRuntime({ policy: 'appVersion' }, base, 'android').value).toBe('1.4.0');
  });

  it('resolves nativeVersion as version(buildNumber|versionCode)', () => {
    const field = { policy: 'nativeVersion' };
    expect(resolveRuntime(field, base, 'ios').value).toBe('1.4.0(12)');
    expect(resolveRuntime(field, base, 'android').value).toBe('1.4.0(12)');
    expect(resolveRuntime(field, { ...base, android: { versionCode: 3 } }, 'android').value).toBe('1.4.0(3)');
  });

  it('does not invent a fingerprint', () => {
    const resolved = resolveRuntime({ policy: 'fingerprint' }, base, 'ios');
    expect(resolved.value).toBeNull();
    expect(resolved.reason).toMatch(/fingerprint/);
  });

  it('fails closed when appVersion has no version', () => {
    const resolved = resolveRuntime({ policy: 'appVersion' }, {}, 'ios');
    expect(resolved.value).toBeNull();
    expect(resolved.reason).toMatch(/expo\.version/);
  });
});
