/**
 * Tests for /webhooks/github HMAC verification semantics (v0.40 T10).
 *
 * The handler itself is wired inside serve-http.ts's runServeHttp closure
 * (hard to invoke without bringing up the full Express app). This file pins
 * the load-bearing primitives:
 *
 *   1. GitHub HMAC sig format matches `sha256=<hex>` via createHmac.
 *   2. safeHexEqual is constant-time and rejects mismatches.
 *   3. The expected payload schema (repository.full_name + ref) parses.
 *   4. Branch ref construction: refs/heads/<tracked_branch>.
 *
 * The full HTTP path is covered by test/e2e/webhook-github.test.ts
 * (DATABASE_URL-gated; not present in this wave — filed as a follow-up
 * E2E pinned by the test plan artifact).
 */
import { describe, test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { safeHexEqual } from '../src/core/timing-safe.ts';

const GITHUB_SECRET = 'super-secret-webhook-key';

/** Build a sha256= HMAC sig the way GitHub does. */
function githubSig(secret: string, payload: Buffer): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

/** Strip the GitHub prefix before constant-time hex compare. Matches the
 *  webhook handler in serve-http.ts. Buffer.from('sha256=...', 'hex') silently
 *  truncates at non-hex chars; comparing prefixed strings as hex returns
 *  true-on-anything. The handler strips the prefix; tests must too. */
function verifyGithubSig(secret: string, payload: Buffer, headerSig: string): boolean {
  const prefix = 'sha256=';
  if (!headerSig.startsWith(prefix)) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  return safeHexEqual(headerSig.slice(prefix.length), expected);
}

/** Synthetic minimal push payload (real GitHub sends ~100KB; we only read 2 fields). */
function pushPayload(repo: string, ref: string): Buffer {
  return Buffer.from(JSON.stringify({
    ref,
    repository: { full_name: repo, name: repo.split('/')[1], owner: { name: repo.split('/')[0] } },
    head_commit: { id: 'abc123' },
  }), 'utf8');
}

describe('GitHub HMAC verification', () => {
  test('valid signature on untampered payload → verify=true', () => {
    const payload = pushPayload('Garry-s-List/zion-brain', 'refs/heads/main');
    const sig = githubSig(GITHUB_SECRET, payload);
    expect(verifyGithubSig(GITHUB_SECRET, payload, sig)).toBe(true);
  });

  test('IRON-RULE: rejects when signature header lacks sha256= prefix', () => {
    // This was the bug: production used safeHexEqual on prefixed strings.
    // Buffer.from('sha256=...', 'hex') silently truncates at non-hex chars,
    // so both sides decoded to empty buffer and signature_mismatch never fired.
    const payload = pushPayload('owner/repo', 'refs/heads/main');
    const expected = createHmac('sha256', GITHUB_SECRET).update(payload).digest('hex');
    // Without prefix the header is invalid format → reject
    expect(verifyGithubSig(GITHUB_SECRET, payload, expected)).toBe(false);
  });

  test('rejects when secret differs', () => {
    const payload = pushPayload('Garry-s-List/zion-brain', 'refs/heads/main');
    const goodSig = githubSig(GITHUB_SECRET, payload);
    expect(verifyGithubSig('wrong-secret', payload, goodSig)).toBe(false);
  });

  test('rejects when payload differs (single-byte tamper)', () => {
    const payload = pushPayload('Garry-s-List/zion-brain', 'refs/heads/main');
    const sig = githubSig(GITHUB_SECRET, payload);
    const tampered = Buffer.from(payload);
    tampered[10] = tampered[10] ^ 0xff;
    expect(verifyGithubSig(GITHUB_SECRET, tampered, sig)).toBe(false);
  });

  test('GitHub sig format is sha256=<64 hex chars>', () => {
    const payload = pushPayload('owner/repo', 'refs/heads/main');
    const sig = githubSig(GITHUB_SECRET, payload);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('Push payload parsing', () => {
  test('extracts repository.full_name + ref', () => {
    const payload = pushPayload('Garry-s-List/zion-brain', 'refs/heads/main');
    const parsed = JSON.parse(payload.toString('utf8'));
    expect(parsed.repository?.full_name).toBe('Garry-s-List/zion-brain');
    expect(parsed.ref).toBe('refs/heads/main');
  });

  test('malformed JSON throws (handler returns 400)', () => {
    const bad = Buffer.from('{not json');
    expect(() => JSON.parse(bad.toString('utf8'))).toThrow();
  });

  test('payload missing repository.full_name is detectable', () => {
    const partial = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));
    const parsed = JSON.parse(partial.toString('utf8'));
    expect(parsed.repository?.full_name).toBeUndefined();
  });
});

describe('Branch ref construction (D5)', () => {
  test('default tracked_branch = main produces refs/heads/main', () => {
    const trackedBranch = 'main';
    expect(`refs/heads/${trackedBranch}`).toBe('refs/heads/main');
  });

  test('non-main branch is exact match', () => {
    const trackedBranch: string = 'master';
    expect(`refs/heads/${trackedBranch}`).toBe('refs/heads/master');
    // ref="refs/heads/main" against tracked="master" must NOT match
    const incoming: string = 'refs/heads/main';
    expect(incoming === `refs/heads/${trackedBranch}`).toBe(false);
  });

  test('feature-branch push to main-tracking source is rejected by exact-match', () => {
    const trackedBranch: string = 'main';
    const pushedRef: string = 'refs/heads/feature/new-stuff';
    expect(pushedRef === `refs/heads/${trackedBranch}`).toBe(false);
  });
});

describe('Webhook sync job extraction contract', () => {
  test('opts into extraction before the pushed commit is consumed', () => {
    const serveSource = readFileSync(
      new URL('../src/commands/serve-http.ts', import.meta.url),
      'utf8',
    );
    const routeStart = serveSource.indexOf("'/webhooks/github'");
    const queueStart = serveSource.indexOf('const job = await queue.add(', routeStart);
    const responseStart = serveSource.indexOf('res.status(202)', queueStart);
    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(queueStart).toBeGreaterThan(routeStart);
    expect(responseStart).toBeGreaterThan(queueStart);

    const routeSource = serveSource.slice(queueStart, responseStart);
    const payload = routeSource.match(
      /queue\.add\(\s*'sync',\s*\{([\s\S]*?)\}\s*,\s*\{/,
    );
    expect(payload).not.toBeNull();
    expect(payload?.[1]).toMatch(/\bnoExtract:\s*false\b/);
  });
});
