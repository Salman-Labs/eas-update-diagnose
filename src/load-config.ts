import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EasBuildProfile, EasJson, ExpoConfig, ResolvedProfile } from './types.js';
import { isRecord } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DYNAMIC_FILES = ['app.config.ts', 'app.config.mts', 'app.config.cts', 'app.config.js', 'app.config.mjs', 'app.config.cjs'];
const STATIC_FILES = ['app.config.json', 'app.json'];

export interface LoadedConfig {
  projectRoot: string;
  appConfigPath: string | null;
  staticConfigPath: string | null;
  easJsonPath: string | null;
  packageJsonPath: string | null;
  expo: ExpoConfig | null;
  eas: EasJson | null;
  profiles: ResolvedProfile[];
  expoUpdatesInstalled: boolean | null;
  loadError: { code: string; message: string } | null;
  easError: { code: string; message: string } | null;
}

export async function loadProject(projectRoot: string): Promise<LoadedConfig> {
  const root = resolve(projectRoot);
  const staticConfigPath = STATIC_FILES.map((name) => join(root, name)).find((file) => existsSync(file)) ?? null;
  const dynamicPath = DYNAMIC_FILES.map((name) => join(root, name)).find((file) => existsSync(file)) ?? null;
  const packageJsonPath = existsSync(join(root, 'package.json')) ? join(root, 'package.json') : null;
  const easJsonPath = existsSync(join(root, 'eas.json')) ? join(root, 'eas.json') : null;

  let staticExpo: ExpoConfig | null = null;
  let loadError: LoadedConfig['loadError'] = null;
  if (staticConfigPath) {
    try {
      staticExpo = asExpoConfig(parseJsonFile(staticConfigPath), staticConfigPath);
    } catch (err) {
      loadError = { code: 'APP_CONFIG_INVALID', message: errorMessage(err) };
    }
  } else if (packageJsonPath) {
    try {
      const pkg = parseJsonFile(packageJsonPath);
      if (isRecord(pkg) && isRecord(pkg.expo)) staticExpo = pkg.expo as ExpoConfig;
    } catch (err) {
      loadError = { code: 'APP_CONFIG_INVALID', message: `package.json: ${errorMessage(err)}` };
    }
  }

  let expo = staticExpo;
  let appConfigPath = dynamicPath ?? staticConfigPath ?? (staticExpo ? packageJsonPath : null);
  if (dynamicPath && !loadError) {
    try {
      const loaded = await loadDynamicConfig(dynamicPath, staticExpo ?? {});
      expo = asExpoConfig(loaded, dynamicPath);
      appConfigPath = dynamicPath;
    } catch (err) {
      loadError = {
        code: 'APP_CONFIG_LOAD_FAILED',
        message: `${dynamicPath}: ${errorMessage(err)}`,
      };
      expo = null;
      appConfigPath = dynamicPath;
    }
  }

  if (!appConfigPath && !loadError) {
    loadError = {
      code: 'APP_CONFIG_MISSING',
      message: 'No app.json, app.config.json, or app.config.* file was found.',
    };
  }

  let eas: EasJson | null = null;
  let easError: LoadedConfig['easError'] = null;
  let profiles: ResolvedProfile[] = [];
  if (easJsonPath) {
    try {
      const parsed = parseJsonFile(easJsonPath);
      if (!isRecord(parsed)) throw new ConfigError('eas.json must be an object');
      eas = parsed as EasJson;
      profiles = resolveProfiles(eas);
    } catch (err) {
      easError = { code: 'EAS_JSON_INVALID', message: errorMessage(err) };
    }
  }

  return {
    projectRoot: root,
    appConfigPath,
    staticConfigPath,
    easJsonPath,
    packageJsonPath,
    expo,
    eas,
    profiles,
    expoUpdatesInstalled: packageJsonPath ? readExpoUpdatesInstalled(packageJsonPath) : null,
    loadError,
    easError,
  };
}

export function resolveProfiles(eas: EasJson): ResolvedProfile[] {
  const build = eas.build;
  if (!build || !isRecord(build)) return [];
  const names = Object.keys(build);
  const resolving = new Set<string>();

  const resolveOne = (name: string): ResolvedProfile => {
    if (resolving.has(name)) {
      throw new ConfigError(`eas.json build profile cycle at "${name}"`);
    }
    const raw = build[name];
    if (!isRecord(raw)) throw new ConfigError(`eas.json build profile "${name}" must be an object`);
    const profile = raw as EasBuildProfile;
    resolving.add(name);
    let parent: ResolvedProfile | null = null;
    if (typeof profile.extends === 'string' && profile.extends) {
      if (!Object.prototype.hasOwnProperty.call(build, profile.extends)) {
        throw new ConfigError(`eas.json build profile "${name}" extends missing profile "${profile.extends}"`);
      }
      parent = resolveOne(profile.extends);
    }
    resolving.delete(name);
    const channel = typeof profile.channel === 'string' ? profile.channel.trim() : '';
    const parentChannel = parent?.channel ?? null;
    return {
      name,
      channel: channel || parentChannel,
      developmentClient: profile.developmentClient ?? parent?.developmentClient ?? false,
      distribution: typeof profile.distribution === 'string' ? profile.distribution : (parent?.distribution ?? null),
      extends: typeof profile.extends === 'string' ? profile.extends : null,
    };
  };

  return names.map((name) => resolveOne(name));
}

export function requestHeaderChannel(expo: ExpoConfig | null): string | null {
  const headers = expo?.updates?.requestHeaders;
  if (!headers || typeof headers !== 'object') return null;
  const value = headers['expo-channel-name'];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function loadDynamicConfig(filePath: string, staticExpo: ExpoConfig): Promise<unknown> {
  const exported = await importConfigModule(filePath);
  const value = typeof exported === 'function' ? await exported({ config: staticExpo, projectRoot: dirname(filePath) }) : exported;
  return value;
}

async function importConfigModule(filePath: string): Promise<unknown> {
  const ext = extname(filePath);
  if (ext === '.json') return parseJsonFile(filePath);
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    const source = readFileSync(filePath, 'utf8');
    const javascript = await transpileTypeScript(source, filePath);
    return importTemporaryModule(filePath, javascript);
  }
  const source = readFileSync(filePath, 'utf8');
  const packageType = nearestPackageType(filePath);
  const esmSyntax = hasEsmSyntax(source);
  if (ext === '.mjs' || (ext === '.js' && (packageType === 'module' || esmSyntax))) {
    if (ext === '.js' && packageType !== 'module' && esmSyntax) return importTemporaryModule(filePath, source);
    const loaded = (await import(pathToFileURL(filePath).href)) as { default?: unknown };
    return loaded.default ?? loaded;
  }
  if (ext === '.cjs' || ext === '.js') {
    const require = createRequire(filePath);
    const loaded = require(filePath) as { default?: unknown };
    if (loaded && typeof loaded === 'object' && 'default' in loaded && loaded.default !== undefined) return loaded.default;
    return loaded;
  }
  throw new ConfigError(`unsupported app config extension ${ext}`);
}

async function transpileTypeScript(source: string, fileName: string): Promise<string> {
  const imported = await import('typescript');
  const ts = imported.default ?? imported;
  const transpiled = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      esModuleInterop: true,
      isolatedModules: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });
  const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const text = errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n');
    throw new ConfigError(text);
  }
  return transpiled.outputText;
}

async function importTemporaryModule(filePath: string, source: string): Promise<unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'eas-update-diagnose-'));
  const outfile = join(directory, `config-${randomBytes(8).toString('hex')}.mjs`);
  const rewritten = rewriteRelativeImports(source, dirname(filePath));
  writeFileSync(outfile, rewritten);
  try {
    const loaded = (await import(pathToFileURL(outfile).href)) as { default?: unknown };
    return loaded.default ?? loaded;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function rewriteRelativeImports(source: string, fromDir: string): string {
  return source.replace(
    /(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (_match, prefix: string, quote: string, spec: string) => {
      const absolute = resolve(fromDir, spec);
      return `${prefix}${quote}${pathToFileURL(absolute).href}${quote}`;
    },
  );
}

function hasEsmSyntax(source: string): boolean {
  return /^\s*import\s/m.test(source) || /^\s*export\s/m.test(source);
}

function nearestPackageType(filePath: string): 'module' | 'commonjs' {
  let dir = dirname(filePath);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { type?: string };
        return parsed.type === 'module' ? 'module' : 'commonjs';
      } catch {
        return 'commonjs';
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return 'commonjs';
    dir = parent;
  }
}

function parseJsonFile(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ConfigError(`${filePath}: ${errorMessage(err)}`);
  }
}

function asExpoConfig(raw: unknown, filePath: string): ExpoConfig {
  if (!isRecord(raw)) throw new ConfigError(`${filePath}: app config must be an object`);
  if (isRecord(raw.expo)) return raw.expo as ExpoConfig;
  return raw as ExpoConfig;
}

function readExpoUpdatesInstalled(packageJsonPath: string): boolean | null {
  try {
    const parsed = parseJsonFile(packageJsonPath);
    if (!isRecord(parsed)) return false;
    const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
    return sections.some((section) => {
      const bag = parsed[section];
      return isRecord(bag) && typeof bag['expo-updates'] === 'string';
    });
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
