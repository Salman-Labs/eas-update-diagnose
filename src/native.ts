import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Platform } from './types.js';

export interface LocaleRuntime {
  qualifier: string;
  value: string;
  file: string;
}

export interface NativePlatform {
  platform: Platform;
  present: boolean;
  runtimeVersion: string | null;
  updateUrl: string | null;
  channel: string | null;
  runtimeMarkedNonTranslatable: boolean | null;
  localeRuntimes: LocaleRuntime[];
  defaultRuntimeFile: string | null;
}

const SKIP = new Set(['node_modules', '.git', 'build', 'Pods', '.gradle']);

export function inspectNative(projectRoot: string): Record<Platform, NativePlatform> {
  return {
    ios: inspectIos(projectRoot),
    android: inspectAndroid(projectRoot),
  };
}

function inspectIos(projectRoot: string): NativePlatform {
  const root = join(projectRoot, 'ios');
  const empty = emptyNative('ios');
  if (!existsSync(root)) return empty;
  const plists = walk(root, (file) => file.endsWith(`${sep}Expo.plist`) || file.endsWith('/Expo.plist'));
  const preferred = plists.find((file) => file.includes(`${sep}Supporting${sep}`)) ?? plists[0];
  if (!preferred) return { ...empty, present: true };
  const parsed = parsePlist(readText(preferred));
  const dict = asDict(parsed);
  const headers = asDict(dict?.EXUpdatesRequestHeaders);
  const channel = headers ? stringValue(headers['expo-channel-name']) : null;
  return {
    platform: 'ios',
    present: true,
    runtimeVersion: dict ? stringValue(dict.EXUpdatesRuntimeVersion) : null,
    updateUrl: dict ? stringValue(dict.EXUpdatesURL) : null,
    channel,
    runtimeMarkedNonTranslatable: null,
    localeRuntimes: [],
    defaultRuntimeFile: relative(projectRoot, preferred),
  };
}

function inspectAndroid(projectRoot: string): NativePlatform {
  const root = join(projectRoot, 'android');
  const empty = emptyNative('android');
  if (!existsSync(root)) return empty;
  const manifests = walk(root, (file) => file.endsWith(`${sep}AndroidManifest.xml`));
  const manifestPath =
    manifests.find((file) => file.endsWith(`${sep}src${sep}main${sep}AndroidManifest.xml`)) ?? manifests[0] ?? null;
  const stringsFiles = walk(root, (file) => file.endsWith(`${sep}strings.xml`));
  const runtimeStrings = stringsFiles.flatMap((file) => readRuntimeStrings(projectRoot, file));
  const defaults = runtimeStrings.filter((entry) => entry.qualifier === 'values');
  const locales = runtimeStrings.filter((entry) => entry.qualifier !== 'values');
  const defaultRuntime = defaults[0]?.value ?? null;
  let manifestRuntime: string | null = null;
  let updateUrl: string | null = null;
  let channel: string | null = null;
  if (manifestPath) {
    const xml = readText(manifestPath);
    for (const tag of matchTags(xml, 'meta-data')) {
      const name = attr(tag.attrs, 'android:name');
      const value = attr(tag.attrs, 'android:value');
      if (!name || value === null) continue;
      if (name === 'expo.modules.updates.EXPO_RUNTIME_VERSION') manifestRuntime = value;
      if (name === 'expo.modules.updates.EXPO_UPDATE_URL') updateUrl = value;
      if (name === 'expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY') {
        channel = channelFromJson(value) ?? channel;
      }
    }
    channel = channel ?? channelFromText(decodeXml(xml));
  }
  if (!channel) {
    for (const file of stringsFiles) {
      const found = channelFromText(decodeXml(readText(file)));
      if (found) {
        channel = found;
        break;
      }
    }
  }
  let runtimeVersion = manifestRuntime;
  if (runtimeVersion?.startsWith('@string/')) {
    const key = runtimeVersion.slice('@string/'.length);
    runtimeVersion = key === 'expo_runtime_version' ? defaultRuntime : (lookupString(stringsFiles, key) ?? null);
  }
  const marked = defaults.find((entry) => entry.translatable === false);
  const anyDefault = defaults[0];
  return {
    platform: 'android',
    present: true,
    runtimeVersion,
    updateUrl,
    channel,
    runtimeMarkedNonTranslatable: anyDefault ? anyDefault.translatable === false || Boolean(marked) : null,
    localeRuntimes: locales
      .filter((entry) => defaultRuntime === null || entry.value !== defaultRuntime)
      .map((entry) => ({ qualifier: entry.qualifier, value: entry.value, file: entry.file })),
    defaultRuntimeFile: defaults[0]?.file ?? (manifestPath ? relative(projectRoot, manifestPath) : null),
  };
}

interface StringEntry {
  qualifier: string;
  value: string;
  file: string;
  translatable: boolean | null;
}

function readRuntimeStrings(projectRoot: string, file: string): StringEntry[] {
  const qualifier = qualifierFromPath(file);
  const xml = readText(file);
  const entries: StringEntry[] = [];
  for (const tag of matchTags(xml, 'string')) {
    const name = attr(tag.attrs, 'name');
    if (name !== 'expo_runtime_version') continue;
    const translatableRaw = attr(tag.attrs, 'translatable');
    entries.push({
      qualifier,
      value: decodeXml(tag.body).trim(),
      file: relative(projectRoot, file),
      translatable: translatableRaw === null ? null : translatableRaw !== 'false',
    });
  }
  return entries;
}

function lookupString(files: string[], name: string): string | null {
  for (const file of files) {
    if (qualifierFromPath(file) !== 'values') continue;
    const xml = readText(file);
    for (const tag of matchTags(xml, 'string')) {
      if (attr(tag.attrs, 'name') === name) return decodeXml(tag.body).trim();
    }
  }
  return null;
}

function qualifierFromPath(file: string): string {
  const parts = file.split(sep);
  const values = [...parts].reverse().find((part) => part === 'values' || part.startsWith('values-'));
  return values ?? 'values';
}

function channelFromJson(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const channel = (parsed as Record<string, unknown>)['expo-channel-name'];
    return typeof channel === 'string' && channel.trim() ? channel.trim() : null;
  } catch {
    return channelFromText(value);
  }
}

function channelFromText(value: string): string | null {
  const match = /expo-channel-name["']?\s*[:=]\s*["']([^"']+)["']/.exec(value);
  return match?.[1]?.trim() || null;
}

function emptyNative(platform: Platform): NativePlatform {
  return {
    platform,
    present: false,
    runtimeVersion: null,
    updateUrl: null,
    channel: null,
    runtimeMarkedNonTranslatable: null,
    localeRuntimes: [],
    defaultRuntimeFile: null,
  };
}

function walk(dir: string, predicate: (file: string) => boolean, depth = 0): string[] {
  if (depth > 8) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, predicate, depth + 1));
    else if (predicate(full)) found.push(full);
  }
  return found;
}

function readText(file: string): string {
  const info = statSync(file);
  if (info.size > 1_000_000) return '';
  return readFileSync(file, 'utf8');
}

interface XmlTag {
  attrs: string;
  body: string;
}

function matchTags(xml: string, name: string): XmlTag[] {
  const tags: XmlTag[] = [];
  const open = new RegExp(`<${name}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml))) {
    const start = match.index;
    const end = xml.indexOf('>', start);
    if (end < 0) break;
    const head = xml.slice(start + name.length + 1, end);
    const selfClosing = /\/\s*$/.test(head);
    const attrs = head.replace(/\/\s*$/, '');
    if (selfClosing) {
      tags.push({ attrs, body: '' });
      open.lastIndex = end + 1;
      continue;
    }
    const close = xml.indexOf(`</${name}>`, end);
    if (close < 0) break;
    tags.push({ attrs, body: xml.slice(end + 1, close) });
    open.lastIndex = close + name.length + 3;
  }
  return tags;
}

function attr(source: string, name: string): string | null {
  const pattern = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(['"])([\\s\\S]*?)\\1`);
  const match = pattern.exec(source);
  return match?.[2] !== undefined ? decodeXml(match[2]) : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

function parsePlist(xml: string): Plist | null {
  const open = xml.indexOf('<plist');
  if (open < 0) return null;
  const start = xml.indexOf('>', open);
  const end = xml.lastIndexOf('</plist>');
  if (start < 0 || end < start) return null;
  const [value] = parsePlistValue(xml.slice(start + 1, end).trim(), 0);
  return value ?? null;
}

function parsePlistValue(source: string, index: number): [Plist | null, number] {
  const slice = source.slice(index).trimStart();
  const offset = source.length - slice.length;
  if (slice.startsWith('<dict')) return parseDict(source, offset);
  if (slice.startsWith('<array')) return parseArray(source, offset);
  if (slice.startsWith('<string')) return parseWrapped(source, offset, 'string');
  if (slice.startsWith('<integer') || slice.startsWith('<real')) {
    const tag = slice.startsWith('<integer') ? 'integer' : 'real';
    const [text, next] = parseWrapped(source, offset, tag);
    return [text === null ? null : Number(text), next];
  }
  if (slice.startsWith('<true')) return [true, offset + skipEmpty(slice, 'true')];
  if (slice.startsWith('<false')) return [false, offset + skipEmpty(slice, 'false')];
  return [null, source.length];
}

function parseDict(source: string, index: number): [Plist | null, number] {
  const openEnd = source.indexOf('>', index);
  if (openEnd < 0) return [null, source.length];
  const dict: { [key: string]: Plist } = {};
  let cursor = openEnd + 1;
  while (cursor < source.length) {
    const rest = source.slice(cursor).trimStart();
    const at = source.length - rest.length;
    if (rest.startsWith('</dict>')) return [dict, at + '</dict>'.length];
    if (!rest.startsWith('<key')) break;
    const [key, afterKey] = parseWrapped(source, at, 'key');
    if (key === null) break;
    const [value, afterValue] = parsePlistValue(source, afterKey);
    if (value !== null) dict[key] = value;
    cursor = afterValue;
  }
  return [dict, cursor];
}

function parseArray(source: string, index: number): [Plist | null, number] {
  const openEnd = source.indexOf('>', index);
  if (openEnd < 0) return [null, source.length];
  const items: Plist[] = [];
  let cursor = openEnd + 1;
  while (cursor < source.length) {
    const rest = source.slice(cursor).trimStart();
    const at = source.length - rest.length;
    if (rest.startsWith('</array>')) return [items, at + '</array>'.length];
    if (!rest.startsWith('<')) break;
    const [value, next] = parsePlistValue(source, at);
    if (next <= at) break;
    if (value !== null) items.push(value);
    cursor = next;
  }
  return [items, cursor];
}

function parseWrapped(source: string, index: number, tag: string): [string | null, number] {
  const open = source.indexOf(`<${tag}`, index);
  if (open < 0) return [null, index];
  const openEnd = source.indexOf('>', open);
  if (openEnd < 0) return [null, index];
  if (source.slice(openEnd - 1, openEnd + 1) === '/>') return ['', openEnd + 1];
  const close = source.indexOf(`</${tag}>`, openEnd);
  if (close < 0) return [null, index];
  return [decodeXml(source.slice(openEnd + 1, close)), close + `</${tag}>`.length];
}

function skipEmpty(slice: string, tag: string): number {
  if (slice.startsWith(`<${tag}/>`)) return `<${tag}/>`.length;
  if (slice.startsWith(`<${tag} />`)) return `<${tag} />`.length;
  const close = slice.indexOf(`</${tag}>`);
  return close < 0 ? slice.length : close + `</${tag}>`.length;
}

function asDict(value: Plist | null | undefined): { [key: string]: Plist } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function stringValue(value: Plist | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
