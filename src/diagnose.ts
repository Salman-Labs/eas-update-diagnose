import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOCS_URL, ERROR_RECOVERY_URL, PLAY_TRANSLATION_ISSUE, RUNTIME_DOCS_URL } from './constants.js';
import { loadProject, requestHeaderChannel } from './load-config.js';
import { fetchManifest } from './manifest.js';
import { inspectNative, type NativePlatform } from './native.js';
import { nativeVersionDefaulted, resolveRuntime, runtimeFieldFor } from './runtime.js';
import type { Check, Diagnosis, ExpoConfig, ManifestProbe, Platform, ResolvedProfile } from './types.js';
import { packageVersion } from './version.js';

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

export interface DiagnoseOptions {
  projectRoot: string;
  profiles?: string[];
  platforms?: Platform[];
  channels?: string[];
  runtimeVersion?: string;
  fetchManifest?: boolean;
  manifestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function diagnose(options: DiagnoseOptions): Promise<Diagnosis> {
  const projectRoot = resolve(options.projectRoot);
  if (!existsSync(projectRoot)) throw new ProjectError(`Project directory not found: ${options.projectRoot}`);
  const loaded = await loadProject(projectRoot);
  const checks: Check[] = [];
  const notes = [
    `Channel-to-branch mapping lives on EAS servers. This tool reads local config only and does not call eas-cli. See ${DOCS_URL}`,
    `If the checklist passes and a device still runs the embedded bundle, the new update may be crashing before the root component renders. EAS Update rolls back with no manifest error. See ${ERROR_RECOVERY_URL}`,
  ];

  if (loaded.loadError) {
    checks.push({ code: loaded.loadError.code, status: 'fail', message: loaded.loadError.message });
  }
  if (loaded.easError) {
    checks.push({ code: loaded.easError.code, status: 'fail', message: loaded.easError.message });
  }

  const expo = loaded.loadError ? null : loaded.expo;
  const profiles = loaded.easError ? [] : selectProfiles(loaded.profiles, options.profiles);
  if (options.profiles && !loaded.easError) {
    for (const name of options.profiles) {
      if (!loaded.profiles.some((profile) => profile.name === name)) {
        throw new ProjectError(`Unknown build profile "${name}". eas.json profiles: ${loaded.profiles.map((profile) => profile.name).join(', ') || '(none)'}`);
      }
    }
  }

  const configuredPlatforms = expo ? platformsFromConfig(expo) : [];
  const platforms = options.platforms ?? (configuredPlatforms.length > 0 ? configuredPlatforms : []);
  if (options.platforms && expo && !loaded.loadError) {
    for (const platform of options.platforms) {
      if (!configuredPlatforms.includes(platform)) {
        checks.push({
          code: 'PLATFORM_MISSING',
          status: 'fail',
          platform,
          message: `${platform} is not in the app config platforms list (${configuredPlatforms.join(', ') || 'none'}). An update published for ${platform} will not target this project.`,
        });
      }
    }
  }

  const resolvedRuntime: Diagnosis['resolvedRuntime'] = {};
  let updatesUrl: string | null = null;
  let updatesEnabled: boolean | null = null;
  let projectId: string | null = null;
  const native = inspectNative(projectRoot);

  if (expo && !loaded.loadError) {
    updatesEnabled = expo.updates?.enabled !== false;
    updatesUrl = typeof expo.updates?.url === 'string' ? expo.updates.url.trim() : null;
    if (!updatesUrl) updatesUrl = null;
    projectId = typeof expo.extra?.eas?.projectId === 'string' ? expo.extra.eas.projectId : null;
    checkDependency(checks, loaded.expoUpdatesInstalled, loaded.packageJsonPath);
    checkUpdates(checks, updatesUrl, updatesEnabled, projectId);
    checkRuntime(checks, expo, platforms, resolvedRuntime);
    if (!loaded.easError) checkProfiles(checks, loaded.easJsonPath, profiles, requestHeaderChannel(expo), options.channels);
    checkPlatforms(checks, platforms, configuredPlatforms, native, updatesUrl, resolvedRuntime, profiles);
    checkPlayTranslation(checks, platforms, native.android);
  } else if (!loaded.loadError) {
    checks.push({
      code: 'APP_CONFIG_MISSING',
      status: 'fail',
      message: 'No app.json, app.config.json, or app.config.* file was found.',
    });
  }

  if (!loaded.easJsonPath && !loaded.easError && expo && !loaded.loadError) {
    const headerChannel = requestHeaderChannel(expo);
    if (!headerChannel) {
      checks.push({
        code: 'CHANNEL_UNMAPPED',
        status: 'fail',
        message: 'eas.json is missing, and updates.requestHeaders does not set expo-channel-name. The binary will not send a channel, so EAS cannot map it to a branch.',
      });
    } else {
      checks.push({
        code: 'CHANNEL',
        status: 'pass',
        message: `No eas.json. Local builds can still send channel "${headerChannel}" from updates.requestHeaders. EAS Build will not add a channel unless a build profile sets one.`,
      });
    }
  }

  if (options.runtimeVersion && expo && !loaded.loadError) {
    checks.push(...deviceRuntimeChecks(resolvedRuntime, options.runtimeVersion));
  }

  const manifests: ManifestProbe[] = [];
  if (options.fetchManifest && expo && !loaded.loadError) {
    await probeManifests(checks, manifests, {
      updatesUrl,
      platforms,
      profiles,
      channels: options.channels,
      headerChannel: requestHeaderChannel(expo),
      resolvedRuntime,
      timeoutMs: options.manifestTimeoutMs ?? 10_000,
      fetchImpl: options.fetchImpl ?? fetch,
    });
  }

  const summary = {
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
  };

  return {
    tool: 'eas-update-diagnose',
    version: packageVersion(),
    ok: summary.fail === 0,
    projectRoot,
    appConfigPath: loaded.appConfigPath,
    easJsonPath: loaded.easJsonPath,
    runtimeVersion: expo?.runtimeVersion ?? null,
    resolvedRuntime,
    updatesUrl,
    updatesEnabled,
    projectId,
    platforms,
    profiles,
    expoUpdatesInstalled: loaded.expoUpdatesInstalled,
    checks,
    manifests,
    summary,
    notes,
  };
}

function checkDependency(checks: Check[], installed: boolean | null, packageJsonPath: string | null): void {
  if (installed === true) {
    checks.push({ code: 'EXPO_UPDATES', status: 'pass', message: 'expo-updates is listed in package.json.' });
    return;
  }
  checks.push({
    code: 'EXPO_UPDATES_MISSING',
    status: 'fail',
    message: packageJsonPath
      ? 'expo-updates is not in package.json dependencies. The native client that downloads updates will not be in the binary.'
      : 'package.json is missing, so expo-updates could not be confirmed.',
  });
}

function checkUpdates(
  checks: Check[],
  updatesUrl: string | null,
  updatesEnabled: boolean | null,
  projectId: string | null,
): void {
  if (updatesEnabled === false) {
    checks.push({
      code: 'UPDATES_DISABLED',
      status: 'fail',
      message: 'updates.enabled is false. expo-updates will not request a published update.',
    });
  } else {
    checks.push({ code: 'UPDATES_ENABLED', status: 'pass', message: 'updates.enabled is not false.' });
  }
  if (!updatesUrl) {
    checks.push({
      code: 'UPDATES_URL_MISSING',
      status: 'fail',
      message: 'updates.url is not set. EAS Update has no manifest URL to request. eas update:configure writes https://u.expo.dev/<project-id>.',
    });
    return;
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(updatesUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    checks.push({
      code: 'UPDATES_URL_INVALID',
      status: 'fail',
      message: `updates.url "${updatesUrl}" is not an http(s) URL.`,
    });
    return;
  }
  if (parsed.protocol === 'http:') {
    checks.push({
      code: 'UPDATES_URL_INSECURE',
      status: 'warn',
      message: `updates.url uses http. Device requests should use https: ${updatesUrl}`,
    });
  }
  checks.push({ code: 'UPDATES_URL', status: 'pass', message: `updates.url is ${updatesUrl}` });
  if (parsed.hostname === 'u.expo.dev') {
    const urlId = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    if (!projectId) {
      checks.push({
        code: 'PROJECT_ID_MISSING',
        status: 'warn',
        message: 'updates.url points at u.expo.dev but extra.eas.projectId is not set. The URL path should be the EAS project id.',
      });
    } else if (urlId.toLowerCase() !== projectId.toLowerCase()) {
      checks.push({
        code: 'PROJECT_ID_MISMATCH',
        status: 'fail',
        message: `extra.eas.projectId is ${projectId}, but updates.url targets ${urlId}. The device will request a different project than the one you publish.`,
      });
    } else {
      checks.push({ code: 'PROJECT_ID', status: 'pass', message: 'extra.eas.projectId matches updates.url.' });
    }
  }
}

function checkRuntime(
  checks: Check[],
  expo: ExpoConfig,
  platforms: Platform[],
  resolvedRuntime: Diagnosis['resolvedRuntime'],
): void {
  const targets = platforms.length > 0 ? platforms : (['ios', 'android'] as Platform[]);
  const fields = targets.map((platform) => runtimeFieldFor(expo, platform));
  if (fields.every((field) => field === undefined)) {
    checks.push({
      code: 'RUNTIME_VERSION_MISSING',
      status: 'fail',
      message: 'runtimeVersion is not set. A build and an update are compatible only when they share a runtime version. The default policy is { "policy": "appVersion" }.',
    });
    return;
  }
  const resolved = targets.map((platform) => {
    const field = runtimeFieldFor(expo, platform);
    const result = resolveRuntime(field, expo, platform);
    resolvedRuntime[platform] = result.value;
    return { platform, field, ...result };
  });
  for (const item of resolved) {
    if (item.field === undefined) {
      checks.push({
        code: 'RUNTIME_VERSION_MISSING',
        status: 'fail',
        platform: item.platform,
        message: `${item.platform} has no runtimeVersion. Set a top-level runtimeVersion or ${item.platform}.runtimeVersion.`,
      });
      continue;
    }
    if (item.reason && item.value === null) {
      const code = item.policy === 'fingerprint' ? 'RUNTIME_FINGERPRINT_UNRESOLVED' : 'RUNTIME_POLICY_UNRESOLVED';
      checks.push({
        code,
        status: item.policy === 'fingerprint' ? 'warn' : 'fail',
        platform: item.platform,
        message: `${item.platform} runtimeVersion${item.policy ? ` policy ${item.policy}` : ''} could not be resolved: ${item.reason}. ${RUNTIME_DOCS_URL}`,
      });
    }
    if (nativeVersionDefaulted(expo, item.platform)) {
      checks.push({
        code: 'RUNTIME_NATIVE_VERSION_DEFAULTED',
        status: 'warn',
        platform: item.platform,
        message:
          item.platform === 'ios'
            ? 'nativeVersion policy is missing ios.buildNumber. The resolved runtime uses buildNumber "1", which will not match a binary that incremented it.'
            : 'nativeVersion policy is missing android.versionCode. The resolved runtime uses versionCode 1, which will not match a binary that incremented it.',
      });
    }
  }
  const concrete = resolved.filter((item) => item.value);
  if (concrete.length === targets.length && new Set(concrete.map((item) => item.value)).size === 1) {
    const policy = concrete[0]?.policy;
    checks.push({
      code: 'RUNTIME_VERSION',
      status: 'pass',
      message: `runtimeVersion${policy ? ` policy ${policy}` : ''} resolves to ${concrete[0]?.value} on ${targets.join(' and ')}.`,
    });
  } else if (concrete.length > 1 && new Set(concrete.map((item) => item.value)).size > 1) {
    const detail = concrete.map((item) => `${item.platform} ${item.value}`).join(', ');
    checks.push({
      code: 'RUNTIME_MISMATCH',
      status: 'fail',
      message: `Resolved runtime versions differ by platform (${detail}). An update published for one runtime is never delivered to the other. Align ios.buildNumber and android.versionCode, or publish a separate update for each runtime. ${RUNTIME_DOCS_URL}`,
    });
  } else if (concrete.length === 1 && targets.length === 1) {
    const only = concrete[0]!;
    checks.push({
      code: 'RUNTIME_VERSION',
      status: 'pass',
      message: `runtimeVersion${only.policy ? ` policy ${only.policy}` : ''} resolves to ${only.value} on ${only.platform}.`,
    });
  }
}

function checkProfiles(
  checks: Check[],
  easJsonPath: string | null,
  profiles: ResolvedProfile[],
  headerChannel: string | null,
  requestedChannels: string[] | undefined,
): void {
  if (!easJsonPath) return;
  if (profiles.length === 0) {
    checks.push({
      code: 'CHANNEL_UNMAPPED',
      status: 'fail',
      message: 'eas.json has no build profiles, so no channel can be embedded in a binary.',
    });
    return;
  }
  for (const profile of profiles) {
    if (!profile.channel) {
      checks.push({
        code: 'CHANNEL_UNMAPPED',
        status: profile.developmentClient ? 'warn' : 'fail',
        profile: profile.name,
        message: profile.developmentClient
          ? `Build profile "${profile.name}" is a development client with no channel. Development builds load from Metro and do not apply published updates unless EX_UPDATES_NATIVE_DEBUG=1.`
          : `Build profile "${profile.name}" has no channel${profile.extends ? ` (extends ${profile.extends})` : ''}. The binary will not send expo-channel-name, so EAS cannot map it to a branch.`,
      });
      continue;
    }
    const inherited = profile.extends ? ` (extends ${profile.extends})` : '';
    checks.push({
      code: 'CHANNEL',
      status: 'pass',
      profile: profile.name,
      message: `Build profile "${profile.name}" uses channel "${profile.channel}"${inherited}.`,
    });
    if (headerChannel && headerChannel !== profile.channel) {
      checks.push({
        code: 'CHANNEL_HEADER_MISMATCH',
        status: 'warn',
        profile: profile.name,
        message: `updates.requestHeaders expo-channel-name is "${headerChannel}", but profile "${profile.name}" sets channel "${profile.channel}". EAS Build embeds the eas.json channel.`,
      });
    }
  }
  if (requestedChannels && requestedChannels.length > 0) {
    const known = new Set(profiles.map((profile) => profile.channel).filter((channel): channel is string => Boolean(channel)));
    if (headerChannel) known.add(headerChannel);
    for (const channel of requestedChannels) {
      if (!known.has(channel)) {
        checks.push({
          code: 'CHANNEL_UNMAPPED',
          status: 'fail',
          message: `Channel "${channel}" is not set on any selected build profile.`,
        });
      }
    }
  }
}

function checkPlatforms(
  checks: Check[],
  platforms: Platform[],
  configured: Platform[],
  native: Record<Platform, NativePlatform>,
  updatesUrl: string | null,
  resolvedRuntime: Diagnosis['resolvedRuntime'],
  profiles: ResolvedProfile[],
): void {
  if (configured.length === 0) {
    checks.push({
      code: 'PLATFORM_MISSING',
      status: 'fail',
      message: 'App config platforms excludes both ios and android. EAS Update delivers to native binaries.',
    });
  }
  for (const platform of platforms) {
    const info = native[platform];
    if (!info.present) continue;
    const missing: string[] = [];
    if (!info.updateUrl) missing.push(platform === 'ios' ? 'EXUpdatesURL' : 'expo.modules.updates.EXPO_UPDATE_URL');
    if (!info.runtimeVersion) missing.push(platform === 'ios' ? 'EXUpdatesRuntimeVersion' : 'expo.modules.updates.EXPO_RUNTIME_VERSION');
    if (missing.length > 0) {
      checks.push({
        code: 'PLATFORM_MISSING',
        status: 'fail',
        platform,
        message: `${platform} native project is missing ${missing.join(' and ')}. A binary produced from this directory will not request updates until those values are embedded.`,
      });
    } else {
      checks.push({
        code: 'NATIVE_CONFIG',
        status: 'pass',
        platform,
        message: `${platform} native project sets the update URL and runtime version${info.defaultRuntimeFile ? ` (${info.defaultRuntimeFile})` : ''}.`,
      });
    }
    if (info.updateUrl && updatesUrl && info.updateUrl !== updatesUrl) {
      checks.push({
        code: 'UPDATES_URL_NATIVE_MISMATCH',
        status: 'fail',
        platform,
        message: `${platform} native update URL is ${info.updateUrl}, but app config updates.url is ${updatesUrl}. The installed binary requests the native URL.`,
      });
    }
    const expected = resolvedRuntime[platform];
    if (info.runtimeVersion && expected && info.runtimeVersion !== expected) {
      checks.push({
        code: 'RUNTIME_MISMATCH',
        status: 'fail',
        platform,
        message: `${platform} native runtime version is "${info.runtimeVersion}", but the app config resolves to "${expected}". The device asks for ${info.runtimeVersion}, so an update published at ${expected} is never delivered. Rebuild after changing runtimeVersion.`,
      });
    }
    if (!info.channel) {
      checks.push({
        code: 'CHANNEL_UNMAPPED',
        status: 'fail',
        platform,
        message: `${platform} native project does not embed expo-channel-name. eas.json channels are copied into the binary at build time; this native project has not been rebuilt with a channel.`,
      });
    } else {
      const profileChannels = profiles.map((profile) => profile.channel).filter((channel): channel is string => Boolean(channel));
      if (profileChannels.length > 0 && !profileChannels.includes(info.channel)) {
        checks.push({
          code: 'CHANNEL_HEADER_MISMATCH',
          status: 'fail',
          platform,
          message: `${platform} native project sends channel "${info.channel}", which is not set on any selected build profile (${profileChannels.join(', ')}). The device will not see updates published to those profiles.`,
        });
      }
    }
  }
}

function checkPlayTranslation(checks: Check[], platforms: Platform[], android: NativePlatform): void {
  if (!platforms.includes('android')) return;
  if (android.localeRuntimes.length > 0) {
    const detail = android.localeRuntimes.map((entry) => `${entry.file} = "${entry.value}"`).join('; ');
    checks.push({
      code: 'PLAY_TRANSLATION_HINT',
      status: 'fail',
      platform: 'android',
      message: `Android string expo_runtime_version is overridden per locale (${detail}). Google Play's automatic app-string translation rewrites this resource after upload, so devices in that locale request a stale runtime and the server returns NoUpdatesAvailable with no error. Disable App string translation in Play Console and upload a new bundle. ${PLAY_TRANSLATION_ISSUE}`,
    });
    return;
  }
  const marked = android.runtimeMarkedNonTranslatable === true;
  checks.push({
    code: 'PLAY_TRANSLATION_HINT',
    status: 'warn',
    platform: 'android',
    message: marked
      ? `Android expo_runtime_version is marked translatable="false", which is the config-plugins fix, but Play Console may already have translated an older bundle. Disable automatic app-string translation and upload a new bundle before trusting locale-specific devices. ${PLAY_TRANSLATION_ISSUE}`
      : `Android stores expo_runtime_version as a string resource. Google Play automatic app-string translation can rewrite it per locale after upload, so some devices request a stale runtime and never apply an update that iOS receives. Disable Play Console app-string translation, or confirm the string is translatable="false", then upload a new bundle. ${PLAY_TRANSLATION_ISSUE}`,
  });
}

async function probeManifests(
  checks: Check[],
  manifests: ManifestProbe[],
  input: {
    updatesUrl: string | null;
    platforms: Platform[];
    profiles: ResolvedProfile[];
    channels: string[] | undefined;
    headerChannel: string | null;
    resolvedRuntime: Diagnosis['resolvedRuntime'];
    timeoutMs: number;
    fetchImpl: typeof fetch;
  },
): Promise<void> {
  if (!input.updatesUrl) {
    checks.push({
      code: 'MANIFEST_FETCH_FAILED',
      status: 'fail',
      message: 'Cannot fetch a manifest because updates.url is missing.',
    });
    return;
  }
  const channels = input.channels && input.channels.length > 0
    ? input.channels
    : unique([
        ...input.profiles.map((profile) => profile.channel).filter((channel): channel is string => Boolean(channel)),
        ...(input.profiles.length === 0 && input.headerChannel ? [input.headerChannel] : []),
      ]);
  if (channels.length === 0) {
    checks.push({
      code: 'MANIFEST_FETCH_FAILED',
      status: 'fail',
      message: 'Cannot fetch a manifest because no channel is configured.',
    });
    return;
  }
  const seen = new Set<string>();
  for (const platform of input.platforms) {
    const runtimeVersion = input.resolvedRuntime[platform];
    if (!runtimeVersion) {
      checks.push({
        code: 'MANIFEST_FETCH_FAILED',
        status: 'fail',
        platform,
        message: `Cannot fetch the ${platform} manifest because the runtime version did not resolve.`,
      });
      continue;
    }
    for (const channel of channels) {
      const key = `${platform}\0${channel}\0${runtimeVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const probe = await fetchManifest(
        { url: input.updatesUrl, platform, channel, runtimeVersion },
        input.fetchImpl,
        input.timeoutMs,
      );
      manifests.push(probe);
      if (probe.error && !probe.directive && !probe.manifestRuntimeVersion) {
        checks.push({
          code: 'MANIFEST_FETCH_FAILED',
          status: 'fail',
          platform,
          message: `Manifest request for ${platform} channel "${channel}" runtime "${runtimeVersion}" failed: ${probe.error}`,
        });
        continue;
      }
      if (probe.directive === 'rollBackToEmbedded') {
        checks.push({
          code: 'MANIFEST_ROLLBACK',
          status: 'fail',
          platform,
          message: `Update server returned rollBackToEmbedded for ${platform} channel "${channel}" runtime "${runtimeVersion}". Devices will keep the embedded bundle.`,
        });
        continue;
      }
      if (probe.directive === 'noUpdateAvailable' || (!probe.manifestRuntimeVersion && probe.httpStatus === 404)) {
        checks.push({
          code: 'MANIFEST_NO_UPDATE',
          status: 'fail',
          platform,
          message: `No compatible update for ${platform} channel "${channel}" runtime "${runtimeVersion}" (HTTP ${probe.httpStatus ?? 'n/a'}). Publish an update with that runtime, platform, and channel.`,
        });
        continue;
      }
      if (probe.manifestRuntimeVersion && probe.manifestRuntimeVersion !== runtimeVersion) {
        checks.push({
          code: 'RUNTIME_MISMATCH',
          status: 'fail',
          platform,
          message: `Manifest runtimeVersion is "${probe.manifestRuntimeVersion}" but the project resolves to "${runtimeVersion}" for ${platform}.`,
        });
        continue;
      }
      if (probe.manifestRuntimeVersion) {
        checks.push({
          code: 'MANIFEST',
          status: 'pass',
          platform,
          message: `Manifest for ${platform} channel "${channel}" runtime "${runtimeVersion}" is available${probe.updateId ? ` (update ${probe.updateId})` : ''}.`,
        });
        continue;
      }
      checks.push({
        code: 'MANIFEST_FETCH_FAILED',
        status: 'fail',
        platform,
        message: `Manifest response for ${platform} channel "${channel}" did not include an update (HTTP ${probe.httpStatus ?? 'n/a'}).`,
      });
    }
  }
}

function selectProfiles(profiles: ResolvedProfile[], names: string[] | undefined): ResolvedProfile[] {
  if (!names || names.length === 0) return profiles;
  const wanted = new Set(names);
  return profiles.filter((profile) => wanted.has(profile.name));
}

function platformsFromConfig(expo: ExpoConfig): Platform[] {
  if (!expo.platforms || expo.platforms.length === 0) return ['ios', 'android'];
  return expo.platforms.filter((platform): platform is Platform => platform === 'ios' || platform === 'android');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function deviceRuntimeChecks(resolvedRuntime: Diagnosis['resolvedRuntime'], deviceRuntime: string | undefined): Check[] {
  if (!deviceRuntime) return [];
  const checks: Check[] = [];
  const entries = Object.entries(resolvedRuntime) as Array<[Platform, string | null | undefined]>;
  for (const [platform, resolved] of entries) {
    if (!resolved) continue;
    if (resolved !== deviceRuntime) {
      checks.push({
        code: 'RUNTIME_MISMATCH',
        status: 'fail',
        platform,
        message: `Device runtime "${deviceRuntime}" does not match the ${platform} config runtime "${resolved}". The device only accepts updates published with ${deviceRuntime}.`,
      });
    } else {
      checks.push({
        code: 'RUNTIME_VERSION',
        status: 'pass',
        platform,
        message: `Device runtime "${deviceRuntime}" matches the resolved ${platform} runtime.`,
      });
    }
  }
  return checks;
}
