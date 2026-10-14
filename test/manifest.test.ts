import { describe, expect, it } from 'vitest';
import { interpretManifest, manifestHeaders } from '../src/manifest.js';

describe('manifest', () => {
  it('sends platform, runtime, and channel headers', () => {
    expect(manifestHeaders({ platform: 'android', runtimeVersion: '1.4.0', channel: 'production' })).toMatchObject({
      'expo-protocol-version': '1',
      'expo-platform': 'android',
      'expo-runtime-version': '1.4.0',
      'expo-channel-name': 'production',
    });
  });

  it('reads a JSON manifest', () => {
    const parsed = interpretManifest(
      200,
      'application/json',
      JSON.stringify({ id: 'upd_1', runtimeVersion: '1.4.0', launchAsset: { key: 'bundle' }, assets: [] }),
    );
    expect(parsed).toMatchObject({ manifestRuntimeVersion: '1.4.0', updateId: 'upd_1', directive: null, error: null });
  });

  it('reads a multipart manifest and a no-update directive', () => {
    const boundary = 'expoboundary';
    const body = [
      `--${boundary}`,
      'content-type: application/json',
      '',
      JSON.stringify({ id: 'upd_2', runtimeVersion: '1.0.0', assets: [], launchAsset: { key: 'js' } }),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    expect(interpretManifest(200, `multipart/mixed; boundary=${boundary}`, body).updateId).toBe('upd_2');

    const directive = [
      `--${boundary}`,
      'content-type: application/json',
      '',
      JSON.stringify({ type: 'noUpdateAvailable' }),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    expect(interpretManifest(200, `multipart/mixed; boundary="${boundary}"`, directive).directive).toBe('noUpdateAvailable');
  });

  it('treats a classic 404 body as no update', () => {
    const parsed = interpretManifest(404, 'application/json', JSON.stringify({ message: 'No compatible update found' }));
    expect(parsed.directive).toBe('noUpdateAvailable');
  });

  it('records a rollback directive', () => {
    expect(interpretManifest(200, 'application/json', JSON.stringify({ type: 'rollBackToEmbedded' })).directive).toBe(
      'rollBackToEmbedded',
    );
  });
});
