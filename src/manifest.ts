import { PROTOCOL_VERSION } from './constants.js';
import type { ManifestProbe, Platform } from './types.js';

export interface ManifestRequest {
  url: string;
  platform: Platform;
  channel: string;
  runtimeVersion: string;
}

export function manifestHeaders(request: Pick<ManifestRequest, 'platform' | 'channel' | 'runtimeVersion'>): Record<string, string> {
  return {
    accept: 'application/expo+json, application/json',
    'expo-protocol-version': PROTOCOL_VERSION,
    'expo-platform': request.platform,
    'expo-runtime-version': request.runtimeVersion,
    'expo-channel-name': request.channel,
    'expo-json-error': 'true',
  };
}

export async function fetchManifest(
  request: ManifestRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ManifestProbe> {
  const headers = manifestHeaders(request);
  const base = {
    url: request.url,
    platform: request.platform,
    channel: request.channel,
    runtimeVersion: request.runtimeVersion,
  };
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return { ...base, httpStatus: null, manifestRuntimeVersion: null, updateId: null, directive: null, error: 'updates.url is not a URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ...base,
      httpStatus: null,
      manifestRuntimeVersion: null,
      updateId: null,
      directive: null,
      error: `refusing to fetch ${parsed.protocol} URLs`,
    };
  }
  try {
    const response = await fetchImpl(request.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const interpreted = interpretManifest(response.status, contentType, body);
    return { ...base, httpStatus: response.status, ...interpreted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      httpStatus: null,
      manifestRuntimeVersion: null,
      updateId: null,
      directive: null,
      error: message,
    };
  }
}

export interface InterpretedManifest {
  manifestRuntimeVersion: string | null;
  updateId: string | null;
  directive: string | null;
  error: string | null;
}

export function interpretManifest(status: number, contentType: string, body: string): InterpretedManifest {
  const documents = extractJsonDocuments(contentType, body);
  let manifestRuntimeVersion: string | null = null;
  let updateId: string | null = null;
  let directive: string | null = null;
  let error: string | null = null;
  for (const document of documents) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) continue;
    const record = document as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : null;
    if (type === 'noUpdateAvailable' || type === 'rollBackToEmbedded') {
      directive = type;
      continue;
    }
    if (typeof record.runtimeVersion === 'string' && (record.launchAsset !== undefined || record.assets !== undefined || record.id !== undefined)) {
      manifestRuntimeVersion = record.runtimeVersion;
      updateId = typeof record.id === 'string' ? record.id : null;
      continue;
    }
    const errors = Array.isArray(record.errors) ? record.errors : null;
    if (errors) {
      const first = errors.find((entry) => entry && typeof entry === 'object') as { message?: unknown; code?: unknown } | undefined;
      const text = typeof first?.message === 'string' ? first.message : null;
      if (text && /no compatible update|no update available|not found/i.test(text)) directive = directive ?? 'noUpdateAvailable';
      else error = text ?? error;
    }
    if (typeof record.message === 'string' && !manifestRuntimeVersion) {
      if (/no compatible update|no update available|not found/i.test(record.message)) directive = directive ?? 'noUpdateAvailable';
      else error = error ?? record.message;
    }
  }
  if (!manifestRuntimeVersion && !directive && !error) {
    if (status === 404 || status === 204) directive = 'noUpdateAvailable';
    else if (status >= 400) error = `HTTP ${status}`;
    else if (documents.length === 0 && body.trim()) error = 'manifest response was not JSON';
  }
  return { manifestRuntimeVersion, updateId, directive, error };
}

function extractJsonDocuments(contentType: string, body: string): unknown[] {
  if (/multipart\//i.test(contentType)) {
    const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
    if (!boundary) return [];
    return splitMultipart(body, boundary)
      .map((part) => {
        const splitAt = part.indexOf('\r\n\r\n');
        const alt = part.indexOf('\n\n');
        const cut = splitAt >= 0 ? splitAt + 4 : alt >= 0 ? alt + 2 : -1;
        if (cut < 0) return null;
        return parseJson(part.slice(cut).trim());
      })
      .filter((value): value is unknown => value !== null);
  }
  const parsed = parseJson(body.trim());
  return parsed === null ? [] : [parsed];
}

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  return body
    .split(marker)
    .slice(1)
    .map((part) => part.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
    .filter((part) => part !== '--' && !part.startsWith('--'));
}

function parseJson(text: string): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
