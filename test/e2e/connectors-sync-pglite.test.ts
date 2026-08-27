/**
 * connectors-sync e2e (PGLite) — the chat-connectors pipeline end-to-end.
 *
 * The REAL ConnectorClient runs against a scriptable Bun.serve fixture backend
 * (retry/classify/pace/off-origin all exercised), then the real
 * runTranscriptsIngest lands pages in a real embedded brain. Retrieval is
 * asserted WITHOUT an embedding key via getPage + searchKeyword. Credentials +
 * spool are isolated under a temp GBRAIN_HOME.
 *
 * Groups: A full pipeline · B incremental+watermark (incl. the >7-day-gap
 * regression) · C idempotency/updates · D adapter edge cases · E redaction ·
 * G HTTP client behavior · K dry-run/limit/receipt/spool.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runConnectorSync } from '../../src/core/connectors/sync.ts';
import { saveCredential } from '../../src/core/connectors/credentials.ts';
import { watermarkKey, lastSyncAtKey, authErrorAtKey } from '../../src/core/connectors/config-keys.ts';
import { buildTranscriptSlug } from '../../src/core/transcripts/types.ts';
import { CHATGPT_BASE_URL } from '../../src/core/connectors/providers/chatgpt.ts';
import { CLAUDE_BASE_URL } from '../../src/core/connectors/providers/claude.ts';
import {
  type FixtureConversation,
  type FixtureState,
  chatgptHandler,
  claudeHandler,
  newFixtureState,
  startFixture,
} from '../fixtures/connectors/fixture-server.ts';
import type { ConnectorFetch } from '../../src/core/connectors/client.ts';

let engine: PGLiteEngine;
let tmp: string;
let prevHome: string | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
});
beforeEach(async () => {
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-connectors-e2e-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp; // isolates ~/.gbrain/connectors + spool
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A fetch that rewrites the provider's real origin to the fixture origin so the
 *  real client (incl. baseUrl origin guard + refresh path) runs against it. */
function rewritingFetch(realBase: string, fixtureBase: string): ConnectorFetch {
  return (url, init) => fetch(url.replace(realBase, fixtureBase), init);
}

function saveChatgptCookie(): void {
  saveCredential({ provider: 'chatgpt', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
}
function saveClaudeCookie(): void {
  saveCredential({ provider: 'claude', strategy: 'browser-session', cookie: 'sessionKey=fixture', savedAt: new Date(0).toISOString() });
}

function conv(id: string, title: string, updateTime: number, turns: FixtureConversation['turns'], extra: Partial<FixtureConversation> = {}): FixtureConversation {
  return { id, title, createTime: updateTime - 100, updateTime, turns, ...extra };
}

const T0 = 1_786_000_000; // a fixed epoch-seconds base (no Date.now in fixtures)

const NOW_MS = (T0 + 100_000) * 1000;
const NOOP_SLEEP = () => Promise.resolve(); // pacing/backoff isn't what these tests assert

async function runChatgpt(state: FixtureState, opts: Record<string, unknown> = {}) {
  const srv = startFixture(chatgptHandler(state));
  try {
    return await runConnectorSync(engine, {
      provider: 'chatgpt',
      sourceId: 'default',
      deps: { fetchImpl: rewritingFetch(CHATGPT_BASE_URL, srv.baseUrl), now: () => NOW_MS, sleep: NOOP_SLEEP },
      ...(opts as object),
    });
  } finally {
    srv.stop();
  }
}

// ── A. Full pipeline ────────────────────────────────────────────────────────
describe('A. full pipeline', () => {
  test('A1 chatgpt: paginated list → detail → ingest → searchable page (canonical path only)', async () => {
    saveChatgptCookie();
    const convs: FixtureConversation[] = [];
    for (let i = 0; i < 40; i++) {
      convs.push(conv(`c-${i}`, `Widget topic ${i}`, T0 + i, [
        { role: 'user', text: `question about widget ${i}` },
        { role: 'assistant', text: `LaunchPanel answer ${i}` },
      ], i === 0 ? { abandonedBranchText: 'BRANCH-A-ONLY-TEXT' } : {}));
    }
    const state = newFixtureState(convs);
    const r = await runChatgpt(state);
    expect(r.status).toBe('success');
    expect(r.listed).toBe(40);
    expect(r.fetched).toBe(40);
    expect(r.ingest?.imported).toBe(40);
    // exact slug for c-0
    const slug = buildTranscriptSlug('chatgpt', new Date(T0 * 1000).toISOString(), { sessionId: 'c-0', title: 'Widget topic 0' });
    expect(slug).toContain('conversations/chatgpt/');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.type).toBe('conversation');
    expect(page!.compiled_truth).toContain('LaunchPanel answer 0');
    expect(page!.compiled_truth).not.toContain('BRANCH-A-ONLY-TEXT'); // abandoned branch dropped
    // retrievable with NO embedding key (lexical FTS)
    const hits = await engine.searchKeyword('LaunchPanel', { limit: 50 });
    expect(hits.some((h) => h.slug === slug)).toBe(true);
  });

  test('A2 claude: list → detail → ingest under conversations/claude/', async () => {
    saveClaudeCookie();
    const state = newFixtureState([
      conv('cl-1', 'Deal memo review', T0 + 5, [
        { role: 'user', text: 'what is the fund-a term sheet date' },
        { role: 'assistant', text: 'the term sheet date is next Tuesday' },
      ]),
    ]);
    const srv = startFixture(claudeHandler(state));
    try {
      const r = await runConnectorSync(engine, {
        provider: 'claude',
        sourceId: 'default',
        deps: { fetchImpl: rewritingFetch(CLAUDE_BASE_URL, srv.baseUrl), now: () => NOW_MS, sleep: NOOP_SLEEP },
      });
      expect(r.status).toBe('success');
      expect(r.ingest?.imported).toBe(1);
      const slug = buildTranscriptSlug('claude-export', new Date((T0 + 5) * 1000).toISOString(), { sessionId: 'cl-1', title: 'Deal memo review' });
      expect(slug).toContain('conversations/claude/');
      const page = await engine.getPage(slug, { sourceId: 'default' });
      expect(page).not.toBeNull();
      expect(page!.compiled_truth).toContain('term sheet date');
      const fm = page!.frontmatter as Record<string, { harness?: string }>;
      expect(fm.transcript_import.harness).toBe('claude-export');
    } finally {
      srv.stop();
    }
  });
});

// ── B. Incremental sync + watermark (config scalar, not op_checkpoint) ───────
describe('B. incremental + watermark', () => {
  test('B4 second run, no new convs → nothing_new, no NEW imports, watermark unchanged (windowDays:0)', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }])]);
    const r1 = await runChatgpt(state, { windowDays: 0 });
    expect(r1.ingest?.imported).toBe(1);
    const wm1 = await engine.getConfig(watermarkKey('chatgpt'));
    expect(wm1).toBe(new Date((T0 + 10) * 1000).toISOString());
    state.hits = {}; // reset counters between runs
    const r2 = await runChatgpt(state, { windowDays: 0 });
    expect(r2.status).toBe('nothing_new');
    expect(state.hits.detail ?? 0).toBe(0); // windowDays:0 → boundary conv excluded, nothing re-fetched
    expect(await engine.getConfig(watermarkKey('chatgpt'))).toBe(wm1);
  });

  test('B5 only the new conversation is detail-fetched; watermark advances (windowDays:0)', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }])]);
    await runChatgpt(state, { windowDays: 0 });
    state.hits = {};
    state.conversations.push(conv('c-2', 'B', T0 + 500, [{ role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2 fresh' }]));
    const r = await runChatgpt(state, { windowDays: 0 });
    expect(state.hits['detail:c-2']).toBe(1);
    expect(state.hits['detail:c-1'] ?? 0).toBe(0); // old one excluded (windowDays:0)
    expect(r.ingest?.imported).toBe(1);
    expect(await engine.getConfig(watermarkKey('chatgpt'))).toBe(new Date((T0 + 500) * 1000).toISOString());
  });

  test('B6 >30-day gap survives: next run is incremental, not a full history re-fetch', async () => {
    saveChatgptCookie();
    // 20 old convs spaced 10 days apart (so the trailing window catches at most
    // the boundary one), watermark seeded from them.
    const oldConvs: FixtureConversation[] = [];
    for (let i = 0; i < 20; i++) {
      // All BEFORE T0, spaced 10 days apart: old-0 = T0-40d (newest, = watermark),
      // old-19 = T0-230d. The new conv at T0 is 40 days after the watermark.
      oldConvs.push(conv(`old-${i}`, `old ${i}`, T0 - (40 + i * 10) * 86400, [{ role: 'user', text: `oq${i}` }, { role: 'assistant', text: `oa${i}` }]));
    }
    const state = newFixtureState(oldConvs);
    await runChatgpt(state, { full: true });
    expect(await engine.getConfig(watermarkKey('chatgpt'))).toBeTruthy();
    state.hits = {};
    // A single new conv arrives well after the newest old one.
    state.conversations.push(conv('new-1', 'new', T0, [{ role: 'user', text: 'nq' }, { role: 'assistant', text: 'na' }]));
    const r = await runChatgpt(state); // default 7-day window
    // Incremental: the new conv + at most the boundary old conv within 7 days —
    // NOT the whole 21-conv history. This proves the config watermark survived
    // the gap (op_checkpoint would have GC'd it → full re-fetch).
    expect(state.hits.detail).toBeLessThan(4);
    expect(state.hits.detail).toBeGreaterThanOrEqual(1);
    expect(r.ingest?.imported).toBe(1); // only new-1 is genuinely new
  });

  test('B7 gap-heal: a conv updated just behind the watermark IS re-listed (trailing window)', async () => {
    saveChatgptCookie();
    const cA = conv('c-A', 'A', T0 + 1000, [{ role: 'user', text: 'qA' }, { role: 'assistant', text: 'aA' }]);
    const cB = conv('c-B', 'B', T0 + 2000, [{ role: 'user', text: 'qB' }, { role: 'assistant', text: 'aB' }]);
    const state = newFixtureState([cA, cB]);
    await runChatgpt(state); // watermark = cB (T0+2000)
    state.hits = {};
    // cA gets a new message ~1 day behind the watermark (within the 7-day window).
    cA.turns.push({ role: 'assistant', text: 'aA GAPHEAL' });
    cA.updateTime = T0 + 2000 - 86400; // 1 day before watermark, inside window
    const r = await runChatgpt(state); // default window re-lists cA
    expect(state.hits['detail:c-A']).toBe(1); // re-fetched via the trailing window
    expect(r.ingest?.imported).toBe(1); // cA re-imported in place with the new turn
  });

  test('B8 a fetch error mid-run → partial, watermark NOT advanced; clean re-run then advances', async () => {
    saveChatgptCookie();
    const state = newFixtureState([
      conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }]),
      conv('c-2', 'B', T0 + 20, [{ role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' }]),
    ]);
    // Force c-1's detail to 500 (server error, exhausts retries → counted error).
    state.script.push({ pathIncludes: '/backend-api/conversation/c-1', status: 500, body: { error: 'boom' } });
    const r = await runChatgpt(state);
    expect(r.status).toBe('partial');
    expect(r.fetchErrors).toBe(1);
    expect(await engine.getConfig(watermarkKey('chatgpt'))).toBeNull(); // never advanced
    // Clear the script; a clean re-run imports both and advances.
    state.script = [];
    const r2 = await runChatgpt(state);
    expect(r2.fetchErrors).toBe(0);
    expect(await engine.getConfig(watermarkKey('chatgpt'))).toBe(new Date((T0 + 20) * 1000).toISOString());
  });
});

// ── C. Idempotency + updates ────────────────────────────────────────────────
describe('C. idempotency + updates', () => {
  test('C9 re-run (full) hash-skips; zero duplicate pages', async () => {
    saveChatgptCookie();
    const state = newFixtureState([
      conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }]),
      conv('c-2', 'B', T0 + 20, [{ role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' }]),
    ]);
    await runChatgpt(state, { full: true });
    const before = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 100 });
    const r2 = await runChatgpt(state, { full: true });
    expect(r2.ingest?.imported).toBe(0);
    expect(r2.ingest?.skipped).toBe(2);
    const after = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 100 });
    expect(after.length).toBe(before.length);
  });

  test('C10 a conversation gaining a message re-imports IN PLACE (no dup page)', async () => {
    saveChatgptCookie();
    const c = conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }]);
    const state = newFixtureState([c]);
    await runChatgpt(state, { full: true });
    const before = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 100 });
    // Append a turn + bump update_time; re-sync full.
    c.turns.push({ role: 'user', text: 'q2 followup' });
    c.turns.push({ role: 'assistant', text: 'a2 UPDATED-CONTENT' });
    c.updateTime = T0 + 50;
    const r = await runChatgpt(state, { full: true });
    expect(r.ingest?.imported).toBe(1); // re-imported (content changed)
    const after = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 100 });
    expect(after.length).toBe(before.length); // no duplicate
    const slug = buildTranscriptSlug('chatgpt', new Date(c.createTime * 1000).toISOString(), { sessionId: 'c-1', title: 'A' });
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('UPDATED-CONTENT');
  });
});

// ── D. Adapter edge cases end-to-end ────────────────────────────────────────
describe('D. adapter edge cases', () => {
  test('D15 a system/empty conversation is skipped, not an error', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-empty', 'Empty', T0 + 10, [])]); // no user/assistant turns
    const r = await runChatgpt(state);
    expect(r.fetchErrors).toBe(0);
    expect(r.ingest?.imported ?? 0).toBe(0);
  });

  test('D-drift a detail with no mapping is counted as a fetch error (drift), run continues', async () => {
    saveChatgptCookie();
    const state = newFixtureState([
      conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }], { omitMapping: true }),
      conv('c-2', 'B', T0 + 20, [{ role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2 good' }]),
    ]);
    const r = await runChatgpt(state);
    expect(r.fetchErrors).toBe(1); // c-1 drift
    expect(r.status).toBe('partial');
    // c-2 still imported
    const slug = buildTranscriptSlug('chatgpt', new Date((T0 + 20 - 100) * 1000).toISOString(), { sessionId: 'c-2', title: 'B' });
    expect(await engine.getPage(slug, { sourceId: 'default' })).not.toBeNull();
  });
});

// ── E. Security / redaction ─────────────────────────────────────────────────
describe('E. redaction', () => {
  test('E18 a planted sk- key is redacted in the page body', async () => {
    saveChatgptCookie();
    const key = ['sk-', 'A'.repeat(28)].join(''); // matches sk-[A-Za-z0-9]{20,}, built at runtime
    const state = newFixtureState([
      conv('c-1', 'Leak', T0 + 10, [
        { role: 'user', text: `here is my key ${key} keep it safe` },
        { role: 'assistant', text: 'noted' },
      ]),
    ]);
    const r = await runChatgpt(state);
    expect(r.ingest?.imported).toBe(1);
    expect(r.ingest!.redactions).toBeGreaterThanOrEqual(1);
    const slug = buildTranscriptSlug('chatgpt', new Date(T0 * 1000).toISOString(), { sessionId: 'c-1', title: 'Leak' });
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).not.toContain(key);
    expect(page!.compiled_truth).toContain('<REDACTED:');
  });
});

// ── G. HTTP client behavior against the real fixture (scripted) ─────────────
describe('G. client behavior', () => {
  test('G26 401 on the first list call → refresh via /api/auth/session → retry → success', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }])]);
    // First list call 401s; the client refreshes (session route) and retries.
    state.script.push({ pathIncludes: '/backend-api/conversations', status: 401, body: { error: 'expired' }, onCall: 1 });
    const r = await runChatgpt(state);
    expect(state.hits.session).toBeGreaterThanOrEqual(1); // refresh happened
    expect(r.ingest?.imported).toBe(1);
  });

  test('G27 401 that persists after refresh → auth_required, stamps auth_error_at, no watermark', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }])]);
    state.script.push({ pathIncludes: '/backend-api/conversations', status: 401, body: { error: 'expired' } }); // every call
    const r = await runChatgpt(state);
    expect(r.status).toBe('auth_required');
    expect(await engine.getConfig(authErrorAtKey('chatgpt'))).toBeTruthy();
    expect(await engine.getConfig(watermarkKey('chatgpt'))).toBeNull();
  });

  test('G28 403 + Cloudflare HTML → forbidden (no JSON-parse crash)', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }])]);
    state.script.push({
      pathIncludes: '/backend-api/conversations',
      status: 403,
      body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>',
      contentType: 'text/html',
    });
    const r = await runChatgpt(state);
    expect(r.status).toBe('forbidden');
    expect(r.hint).toMatch(/export|cookie/i);
  });

  test('G29 403 + JSON body → auth_required (NOT forbidden) — the §2A disambiguation', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }])]);
    state.script.push({ pathIncludes: '/backend-api/conversations', status: 403, body: { error: 'token_expired' } });
    const r = await runChatgpt(state);
    expect(r.status).toBe('auth_required');
  });
});

// ── K. Dry-run, limit, receipt, spool hygiene ───────────────────────────────
describe('K. dry-run / limit / receipt / spool', () => {
  test('K44 dry_run → list-only, zero detail fetches, zero pages, watermark unchanged', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }])]);
    const r = await runChatgpt(state, { dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(state.hits.detail ?? 0).toBe(0);
    expect(await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 10 })).toHaveLength(0);
    expect(await engine.getConfig(watermarkKey('chatgpt'))).toBeNull();
  });

  test('K45 --limit N imports N and does NOT advance the watermark (not clean)', async () => {
    saveChatgptCookie();
    const state = newFixtureState([
      conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }]),
      conv('c-2', 'B', T0 + 20, [{ role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' }]),
      conv('c-3', 'C', T0 + 30, [{ role: 'user', text: 'q3' }, { role: 'assistant', text: 'a3' }]),
    ]);
    const r = await runChatgpt(state, { limit: 2 });
    expect(r.fetched).toBe(2);
    expect(r.status).toBe('partial'); // cap ⇒ not clean
    expect(await engine.getConfig(watermarkKey('chatgpt'))).toBeNull();
  });

  test('K46 the run writes a connector ingest_log receipt', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }])]);
    await runChatgpt(state);
    const log = await engine.getIngestLog({ limit: 20 });
    const rec = log.find((e) => e.source_type === 'connector');
    expect(rec).toBeTruthy();
    expect(rec!.summary).toContain('chatgpt');
  });

  test('K47 last_sync_at is stamped and the spool dir is pruned after ingest', async () => {
    saveChatgptCookie();
    const state = newFixtureState([conv('c-1', 'A', T0 + 10, [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }])]);
    await runChatgpt(state);
    expect(await engine.getConfig(lastSyncAtKey('chatgpt'))).toBeTruthy();
    // spool dir should be empty (pruned in finally)
    const spoolPath = join(tmp, '.gbrain', 'connectors', 'spool', 'chatgpt');
    let entries: string[] = [];
    try {
      entries = (await import('node:fs')).readdirSync(spoolPath).filter((f) => f.endsWith('.json'));
    } catch {
      entries = []; // dir may not exist → also fine
    }
    expect(entries.length).toBe(0);
  });

  test('K-perms saved credential file is 0600', async () => {
    saveChatgptCookie();
    const credFile = join(tmp, '.gbrain', 'connectors', 'chatgpt.json');
    const mode = statSync(credFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
