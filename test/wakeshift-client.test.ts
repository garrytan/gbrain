/**
 * Wakeshift client (src/core/wakeshift/client.ts) and event rendering (events.ts): key parsing with the documented
 * format and a mistyped key, the signed assertion verified with the public key, the console-URL rule, the manifest's
 * routing, the pointer payload (no page text) and emit-id uniqueness.
 */
import { describe, test, expect } from 'bun:test';
import { createPublicKey, verify } from 'node:crypto';
import { crc32, encodeWakeshiftKey, normalizeWakeshiftUrl, parseWakeshiftKey, wakeshiftAssertion, WakeshiftKeyError } from '../src/core/wakeshift/client.ts';
import { formatDuration, jobMarker, jobWake, wakeEmitId, wakeshiftManifest, JOB_FINISHED } from '../src/core/wakeshift/events.ts';
import { wakeshiftUserId } from '../src/core/wakeshift/config.ts';

const SEED = Buffer.alloc(32, 7);
const KEY = encodeWakeshiftKey(SEED);

describe('wakeshift key', () => {
  test('crc32 matches the IEEE check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  test('a current key is wst_ plus 50 base58 characters and round-trips', () => {
    expect(KEY).toMatch(/^wst_[1-9A-HJ-NP-Za-km-z]{50}$/);
    const k = parseWakeshiftKey(`  ${KEY}\n`);
    expect(k.kid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(parseWakeshiftKey(encodeWakeshiftKey(Buffer.alloc(32, 0))).kid).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test('a mistyped key fails its checksum, a short one its format, a legacy one is refused', () => {
    const chars = KEY.split('');
    chars[10] = chars[10] === 'A' ? 'B' : 'A';
    const reason = (raw: string) => { try { parseWakeshiftKey(raw); return 'ok'; } catch (e) { return (e as WakeshiftKeyError).reason; } };
    expect(reason(chars.join(''))).toBe('checksum');
    expect(reason(KEY.slice(0, -1))).toBe('format');
    expect(reason('wst_' + '0'.repeat(50))).toBe('format');
    expect(reason('test_app1_' + Buffer.alloc(32).toString('base64url'))).toBe('legacy');
    expect(reason('wst_live_app1_abc')).toBe('legacy');
  });
});

describe('wakeshift assertion', () => {
  test('header, claims and an Ed25519 signature the public key verifies', () => {
    const key = parseWakeshiftKey(KEY);
    const now = 1_800_000_000;
    const a = wakeshiftAssertion(key, 'https://app.wakeshift.ai', now);
    const [h, c, s] = a.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'EdDSA', typ: 'app+jwt', kid: key.kid });
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: key.kid, sub: key.kid, aud: 'https://app.wakeshift.ai/api/apps', iat: now, exp: now + 120 });
    expect(Buffer.from(claims.jti, 'base64url').length).toBe(16);
    expect(a).not.toContain('=');
    expect(verify(null, Buffer.from(`${h}.${c}`), createPublicKey(key.privateKey), Buffer.from(s!, 'base64url'))).toBe(true);
    expect(wakeshiftAssertion(key, 'https://app.wakeshift.ai', now)).not.toBe(a);
  });

  test('the key never appears in an assertion', () => {
    const a = wakeshiftAssertion(parseWakeshiftKey(KEY), 'https://app.wakeshift.ai');
    expect(a).not.toContain(KEY.slice(4, 20));
    expect(a).not.toContain(SEED.toString('base64url'));
  });
});

describe('wakeshift url', () => {
  test('https anywhere, http only on loopback, no path', () => {
    expect(normalizeWakeshiftUrl(undefined)).toBe('https://app.wakeshift.ai');
    expect(normalizeWakeshiftUrl('https://console.example.com/x/')).toBe('https://console.example.com');
    expect(normalizeWakeshiftUrl('http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567');
    expect(() => normalizeWakeshiftUrl('http://wakeshift.example.com')).toThrow(/https/);
  });
});

describe('wakeshift events', () => {
  test('the manifest routes by the job id and is personal and deleted on delivery', () => {
    const [ev] = wakeshiftManifest().events as any[];
    expect(ev).toMatchObject({ name: JOB_FINISHED, topic: 'ev/gbrain.job.finished/{job}', personal: true, delete_on_delivery: true });
    expect(ev.arguments.required).toEqual(['job']);
    expect(ev.payload.additionalProperties).toBe(false);
  });

  test('the wake is a pointer: ids, status, times and the next call; under 1000 bytes', () => {
    const job = { id: 812, name: 'subagent', status: 'completed', started_at: '2026-11-05T10:00:00.000Z', finished_at: '2026-11-05T10:04:12.000Z', finished_us: '1793872252000000' };
    const w = jobWake(812, job);
    expect(w.text).toBe('gbrain: job 812 (subagent) finished ok in 4m12s. Call get_job 812 for the result.');
    expect(Object.keys(w.payload).sort()).toEqual(['duration_ms', 'finished_at', 'job', 'name', 'next', 'started_at', 'status']);
    expect(w.payload).toMatchObject({ job: 812, status: 'completed', duration_ms: 252000, next: 'get_job 812' });
    expect(Buffer.byteLength(w.text)).toBeLessThan(1000);
    expect(jobWake(9, null).payload).toMatchObject({ job: 9, status: 'gone' });
    expect(jobWake(5, { ...job, id: 5, status: 'dead' }).text).toContain('is dead');
  });

  test('markers and emit ids differ per status, per run and per watcher', () => {
    const j = { id: 1, name: 'x', status: 'failed', started_at: null, finished_at: null, finished_us: '100' };
    expect(jobMarker(j)).toBe('100:failed');
    expect(jobMarker({ ...j, finished_us: '200' })).not.toBe(jobMarker(j));
    expect(jobMarker(null)).toBe('gone');
    expect(wakeEmitId(JOB_FINISHED, '1', '100:failed', 1, 'brain-a')).not.toBe(wakeEmitId(JOB_FINISHED, '1', '100:failed', 2, 'brain-a'));
    expect(wakeEmitId(JOB_FINISHED, '1', 'gone', 1, 'brain-a')).not.toBe(wakeEmitId(JOB_FINISHED, '1', 'gone', 1, 'brain-b'));
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(3_725_000)).toBe('1h02m');
  });

  test('the Wakeshift user is 32 hex and separates principals and brains', () => {
    const s = Buffer.alloc(32, 1);
    const u = wakeshiftUserId(s, 'brain-a', 'local_stdio:local');
    expect(u).toMatch(/^[0-9a-f]{32}$/);
    expect(wakeshiftUserId(s, 'brain-a', 'oauth_client:c1')).not.toBe(u);
    expect(wakeshiftUserId(s, 'brain-b', 'local_stdio:local')).not.toBe(u);
    expect(wakeshiftUserId(Buffer.alloc(32, 2), 'brain-a', 'local_stdio:local')).not.toBe(u);
  });
});
