import type { ExpoConfig, Platform, RuntimeVersionField } from './types.js';

export interface ResolvedRuntime {
  value: string | null;
  policy: string | null;
  reason: string | null;
}

export function runtimeFieldFor(expo: ExpoConfig, platform: Platform): RuntimeVersionField | undefined {
  const specific = expo[platform]?.runtimeVersion;
  if (specific !== undefined) return specific;
  return expo.runtimeVersion;
}

export function resolveRuntime(field: RuntimeVersionField | undefined, expo: ExpoConfig, platform: Platform): ResolvedRuntime {
  if (field === undefined) return { value: null, policy: null, reason: null };
  if (typeof field === 'string') {
    const value = field.trim();
    if (!value) return { value: null, policy: null, reason: 'runtimeVersion is empty' };
    return { value, policy: null, reason: null };
  }
  const policy = typeof field.policy === 'string' ? field.policy : '';
  if (policy === 'appVersion') {
    const version = stringField(expo.version);
    if (!version) {
      return { value: null, policy, reason: 'appVersion policy requires expo.version' };
    }
    return { value: version, policy, reason: null };
  }
  if (policy === 'nativeVersion') {
    const version = stringField(expo.version);
    if (!version) {
      return { value: null, policy, reason: 'nativeVersion policy requires expo.version' };
    }
    const native = platform === 'ios' ? stringField(expo.ios?.buildNumber) ?? '1' : String(expo.android?.versionCode ?? 1);
    return { value: `${version}(${native})`, policy, reason: null };
  }
  if (policy === 'sdkVersion') {
    const sdk = stringField(expo.sdkVersion);
    if (!sdk) return { value: null, policy, reason: 'sdkVersion policy requires expo.sdkVersion' };
    return { value: sdk, policy, reason: null };
  }
  if (policy === 'fingerprint') {
    return {
      value: null,
      policy,
      reason: 'fingerprint is computed by @expo/fingerprint when the binary is built and when the update is published',
    };
  }
  if (!policy) return { value: null, policy: null, reason: 'runtimeVersion policy is missing' };
  return { value: null, policy, reason: `unknown runtimeVersion policy "${policy}"` };
}

export function nativeVersionDefaulted(expo: ExpoConfig, platform: Platform): boolean {
  const field = runtimeFieldFor(expo, platform);
  if (!field || typeof field === 'string' || field.policy !== 'nativeVersion') return false;
  if (platform === 'ios') return !stringField(expo.ios?.buildNumber);
  return expo.android?.versionCode === undefined || expo.android?.versionCode === null;
}

function stringField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
