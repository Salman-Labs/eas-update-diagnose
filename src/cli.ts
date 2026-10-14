#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { diagnose, ProjectError } from './diagnose.js';
import { formatReport } from './report.js';
import type { Platform } from './types.js';
import { packageVersion } from './version.js';

interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color?: boolean;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

interface ParsedCli {
  help: boolean;
  version: boolean;
  fromProject: string;
  profiles: string[];
  platforms: Platform[];
  channels: string[];
  runtimeVersion?: string;
  fetchManifest: boolean;
  manifestTimeoutMs?: number;
  json: boolean;
  ci: boolean;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      io.stdout(helpText());
      return 0;
    }
    if (args.version) {
      io.stdout(`eas-update-diagnose ${packageVersion()}\n`);
      return 0;
    }
    const diagnosis = await diagnose({
      projectRoot: args.fromProject,
      ...(args.profiles.length > 0 ? { profiles: args.profiles } : {}),
      ...(args.platforms.length > 0 ? { platforms: args.platforms } : {}),
      ...(args.channels.length > 0 ? { channels: args.channels } : {}),
      ...(args.runtimeVersion !== undefined ? { runtimeVersion: args.runtimeVersion } : {}),
      ...(args.fetchManifest ? { fetchManifest: true } : {}),
      ...(args.manifestTimeoutMs !== undefined ? { manifestTimeoutMs: args.manifestTimeoutMs } : {}),
    });
    if (args.json) io.stdout(`${JSON.stringify(diagnosis, null, 2)}\n`);
    else io.stdout(`${formatReport(diagnosis, useColor(io, args.json))}\n`);
    if (args.ci && !diagnosis.ok) return 1;
    return 0;
  } catch (err) {
    if (err instanceof CliError || err instanceof ProjectError) {
      io.stderr(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

export function parseArgs(argv: string[]): ParsedCli {
  let help = false;
  let version = false;
  let json = false;
  let ci = false;
  let fetchManifest = false;
  let fromProject = '.';
  let sawProject = false;
  let runtimeVersion: string | undefined;
  let manifestTimeoutMs: number | undefined;
  const profiles: string[] = [];
  const platforms: Platform[] = [];
  const channels: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      version = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--ci') {
      ci = true;
      continue;
    }
    if (arg === '--fetch-manifest') {
      fetchManifest = true;
      continue;
    }
    const project = take(argv, i, arg, '--from-project');
    if (project) {
      if (sawProject) throw new CliError('--from-project was passed more than once');
      if (!project.value.trim()) throw new CliError('--from-project requires a directory');
      fromProject = project.value;
      sawProject = true;
      i = project.next;
      continue;
    }
    const profile = take(argv, i, arg, '--profile');
    if (profile) {
      if (!profile.value.trim()) throw new CliError('--profile requires a build profile name');
      profiles.push(profile.value);
      i = profile.next;
      continue;
    }
    const platform = take(argv, i, arg, '--platform');
    if (platform) {
      if (platform.value !== 'ios' && platform.value !== 'android') {
        throw new CliError('--platform must be ios or android');
      }
      platforms.push(platform.value);
      i = platform.next;
      continue;
    }
    const channel = take(argv, i, arg, '--channel');
    if (channel) {
      if (!channel.value.trim()) throw new CliError('--channel requires a channel name');
      channels.push(channel.value);
      i = channel.next;
      continue;
    }
    const runtime = take(argv, i, arg, '--runtime-version');
    if (runtime) {
      if (!runtime.value.trim()) throw new CliError('--runtime-version requires a value');
      if (runtimeVersion !== undefined) throw new CliError('--runtime-version was passed more than once');
      runtimeVersion = runtime.value;
      i = runtime.next;
      continue;
    }
    const timeout = take(argv, i, arg, '--manifest-timeout');
    if (timeout) {
      manifestTimeoutMs = numberFlag('--manifest-timeout', timeout.value);
      i = timeout.next;
      continue;
    }
    if (arg.startsWith('--')) throw new CliError(`Unknown option ${arg}.\n\n${helpText()}`);
    throw new CliError(`Unexpected argument ${arg}.\n\n${helpText()}`);
  }

  return {
    help,
    version,
    fromProject,
    profiles,
    platforms,
    channels,
    ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
    fetchManifest,
    ...(manifestTimeoutMs !== undefined ? { manifestTimeoutMs } : {}),
    json,
    ci,
  };
}

function take(argv: string[], index: number, arg: string, flag: string): { value: string; next: number } | null {
  if (arg === flag) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} requires a value`);
    return { value, next: index + 1 };
  }
  if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), next: index };
  return null;
}

function numberFlag(flag: string, raw: string): number {
  if (raw.trim() === '' || !Number.isFinite(Number(raw))) throw new CliError(`${flag} expects a number`);
  const value = Number(raw);
  if (value <= 0) throw new CliError(`${flag} must be greater than 0`);
  return value;
}

function useColor(io: CliIo, json: boolean): boolean {
  if (json) return false;
  if (typeof io.color === 'boolean') return io.color;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return process.stdout.isTTY === true;
}

function helpText(): string {
  return `eas-update-diagnose ${packageVersion()} — why a published EAS Update never reaches a device

Usage:
  eas-update-diagnose --from-project <dir> [options]

Reads app.json / app.config.* and eas.json. It checks runtimeVersion (a fixed
string or a policy), updates.url, the channel on each build profile, and ios
and android. It does not install, publish, or call eas-cli.

Options:
  --from-project <dir>       Expo project. Default: .
  --profile <name>           eas.json build profile. Repeatable. Default: all.
  --platform <ios|android>   Platform to check. Repeatable. Default: app config.
  --channel <name>           Channel the device should be on. Repeatable.
  --runtime-version <ver>    Runtime version reported by the device
                             (Updates.runtimeVersion). Compared to the config.
  --fetch-manifest           GET updates.url with expo-platform,
                             expo-runtime-version, and expo-channel-name.
  --manifest-timeout <ms>    Manifest request timeout. Default 10000.
  --json                     Print the report as JSON.
  --ci                       Exit 1 when a check fails. Warnings stay exit 0.
  --version
  --help

Exit 0 means the checklist had no failures, or --ci was not set.
Exit 1 means --ci and at least one failed check.
Exit 2 means the command was used incorrectly.

Guide: https://docs.expo.dev/eas-update/debug/
Play translation: https://github.com/expo/expo/issues/48148

eas-update-diagnose is not affiliated with Expo.
`;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 2;
    });
}
