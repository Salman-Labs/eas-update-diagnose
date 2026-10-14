export type Platform = 'ios' | 'android';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export type RuntimeVersionField = string | { policy: string };

export interface Check {
  code: string;
  status: CheckStatus;
  message: string;
  platform?: Platform;
  profile?: string;
}

export interface ResolvedProfile {
  name: string;
  channel: string | null;
  developmentClient: boolean;
  distribution: string | null;
  extends: string | null;
}

export interface ManifestProbe {
  url: string;
  platform: Platform;
  channel: string;
  runtimeVersion: string;
  httpStatus: number | null;
  manifestRuntimeVersion: string | null;
  updateId: string | null;
  directive: string | null;
  error: string | null;
}

export interface Diagnosis {
  tool: 'eas-update-diagnose';
  version: string;
  ok: boolean;
  projectRoot: string;
  appConfigPath: string | null;
  easJsonPath: string | null;
  runtimeVersion: RuntimeVersionField | null;
  resolvedRuntime: Partial<Record<Platform, string | null>>;
  updatesUrl: string | null;
  updatesEnabled: boolean | null;
  projectId: string | null;
  platforms: Platform[];
  profiles: ResolvedProfile[];
  expoUpdatesInstalled: boolean | null;
  checks: Check[];
  manifests: ManifestProbe[];
  summary: { pass: number; warn: number; fail: number };
  notes: string[];
}

export interface ExpoUpdatesConfig {
  url?: string;
  enabled?: boolean;
  requestHeaders?: Record<string, string>;
}

export interface ExpoPlatformConfig {
  runtimeVersion?: RuntimeVersionField;
  buildNumber?: string;
  versionCode?: number;
  bundleIdentifier?: string;
  package?: string;
}

export interface ExpoConfig {
  name?: string;
  slug?: string;
  version?: string;
  sdkVersion?: string;
  runtimeVersion?: RuntimeVersionField;
  platforms?: string[];
  updates?: ExpoUpdatesConfig;
  extra?: { eas?: { projectId?: string } };
  ios?: ExpoPlatformConfig;
  android?: ExpoPlatformConfig;
}

export interface EasBuildProfile {
  extends?: string;
  channel?: string;
  distribution?: string;
  developmentClient?: boolean;
  env?: Record<string, string>;
  android?: Record<string, unknown>;
  ios?: Record<string, unknown>;
}

export interface EasJson {
  cli?: { version?: string; appVersionSource?: string };
  build?: Record<string, EasBuildProfile>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
