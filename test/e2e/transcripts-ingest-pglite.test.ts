/**
 * transcripts-ingest e2e (PGLite) — cathedral-4.
 *
 * Pins the import lane end-to-end against a real embedded engine:
 * cross-harness round-trip, dry-run zero-writes, idempotent re-runs,
 * redaction-before-write, part splitting under the embed-skip threshold,
 * the DANGEROUS TRANSITIONS (split→shrink stale-part deletion), since/limit
 * clean-scan semantics, and the putRawData zero-row parity fix.
 *
 * R3/R4: engine in beforeAll, disconnect in afterAll; state reset per test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';
import { runIngestFacts } from '../../src/core/transcripts/ingest-facts.ts';
import {
  buildStatusRows,
  discoverTranscriptFiles,
  indexImportedSessions,
} from '../../src/core/transcripts/discover.ts';
import type { HarnessRoot } from '../../src/core/transcripts/detect.ts';
import { MESSAGE_CHAR_CAP } from '../../src/core/transcripts/render.ts';
import { buildTranscriptSlug } from '../../src/core/transcripts/types.ts';
import { buildHermesFixture } from '../fixtures/transcripts/hermes-fixture-builder.ts';

const CODEX_SLUG = buildTranscriptSlug('codex', '2026-08-02T09:00:00.000Z', {
  sessionId: 'codex-fixture-session-1',
});
const AGENT_SLUG = buildTranscriptSlug('openclaw', '2026-08-03T14:00:00.000Z', {
  sessionId: 'agent-fixture-session-1',
});

const CODEX_FIXTURE = join(import.meta.dir, '..', 'fixtures', 'transcripts', 'codex-rollout.jsonl');
const AGENT_FIXTURE = join(import.meta.dir, '..', 'fixtures', 'transcripts', 'agent-session.jsonl');
const CLAUDE_CODE_FIXTURE = join(
  import.meta.dir,
  '..',
  'fixtures',
  'conversation-formats',
  'claude-code.jsonl',
);
const CHATGPT_FIXTURE = join(
  import.meta.dir,
  '..',
  'fixtures',
  'transcripts',
  'chatgpt-conversations.json',
);
const CLAUDE_EXPORT_FIXTURE = join(
  import.meta.dir,
  '..',
  'fixtures',
  'transcripts',
  'claude-export.json',
);
const GROK_FIXTURE = join(
  import.meta.dir,
  '..',
  'fixtures',
  'transcripts',
  'grok-session',
  'chat_history.jsonl',
);

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-ingest-e2e-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NO_PATTERNS = { userPatternsPath: '/nonexistent-patterns.txt' };

// Synthetic AWS-shaped token, built at runtime so the literal never lands in
// committed bytes (the pre-push credential guard would flag it — correctly).
const PLANTED_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

function baseOpts(paths: string[], extra: Record<string, unknown> = {}) {
  return { paths, sourceId: 'default', ...NO_PATTERNS, ...extra };
}

/** Synthetic openclaw-format session with N large messages. */
function writeBigAgentSession(dir: string, id: string, messageCount: number): string {
  const lines: string[] = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-10T08:00:00.000Z', cwd: '/tmp' }),
  ];
  const filler = 'lorem widget fact '.repeat(Math.ceil((MESSAGE_CHAR_CAP - 100) / 18));
  for (let i = 0; i < messageCount; i++) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `m-${i}`,
        timestamp: `2026-08-10T08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          timestamp: `2026-08-10T08:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
          content: [{ type: 'text', text: `marker-${i} ${filler}` }],
        },
      }),
    );
  }
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('cross-harness round-trip', () => {
  test('codex + openclaw fixtures land as conversation pages in one source', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE, AGENT_FIXTURE]));
    expect(r.sessionsImported).toBe(2);
    expect(r.pages.imported).toBe(2);
    // The committed fixtures carry deliberate malformed tail lines — a
    // possibly-dropped record must freeze the watermark, so this is NOT a
    // clean scan (pristine-file cleanliness is pinned in the since/limit
    // suite below).
    expect(r.cleanScan).toBe(false);
    expect(r.erroredFiles).toBe(0);

    const codexPage = await engine.getPage(CODEX_SLUG, {
      sourceId: 'default',
    });
    expect(codexPage).not.toBeNull();
    expect(codexPage!.type).toBe('conversation');
    expect(codexPage!.compiled_truth).toContain('fund-a led the widget-co seed');
    expect(codexPage!.compiled_truth).not.toContain('PREAMBLE-ONLY-TEXT');

    const agentPage = await engine.getPage(AGENT_SLUG, {
      sourceId: 'default',
    });
    expect(agentPage).not.toBeNull();
    expect(agentPage!.compiled_truth).toContain('acme-seed memo');
    // Cross-harness continuity substrate: both sessions in ONE brain source.
    const fm = agentPage!.frontmatter as Record<string, any>;
    expect(fm.transcript_import.harness).toBe('openclaw');
    expect(fm.transcript_import.session_id).toBe('agent-fixture-session-1');
    expect(fm.date).toBe('2026-08-03');

    // Session metadata rode putRawData onto the base page.
    const raw = await engine.getRawData(agentPage!.slug, undefined, { sourceId: 'default' });
    expect(raw.length).toBeGreaterThan(0);
    expect((raw[0].data as Record<string, unknown>).session_id).toBe('agent-fixture-session-1');
  });
});

describe('--max-bytes reaches the adapters', () => {
  // Pins the WIRING, not the adapter. ingest.ts used to call
  // adapter.parse(path) with no opts at all, so maxBytes could never arrive
  // from the import lane — and an adapter-level test cannot see that, because
  // it calls codexAdapter.parse() directly. Revert the ingest.ts threading and
  // this test is the only thing in the suite that fails.
  test('a rollout over the budget drops mid-file turns but keeps head identity and the tail', async () => {
    const p = join(tmp, 'oversized-rollout.jsonl');
    const line = (payload: Record<string, unknown>, ts: string) =>
      JSON.stringify({ type: 'event_msg', timestamp: ts, payload });
    const filler = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: { type: 'reasoning', content: 'x'.repeat(4000) },
    });
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { session_id: 'wired-sess-1', cwd: '/w', cli_version: '1.2.3' },
      }),
      // Past the 16KB head window (budget/4) and far from the tail, so a
      // correctly-budgeted read MUST drop it. Without the ingest→adapter
      // wiring the whole 1.6MB file is read and this turn survives — which is
      // exactly what makes this test pin the wiring rather than the adapter.
      ...Array(8).fill(filler),
      line({ type: 'user_message', message: 'MIDDLE_TURN_MUST_BE_DROPPED' }, '2026-01-01T00:01:00.000Z'),
      ...Array(400).fill(filler),
      line({ type: 'user_message', message: 'NEWEST_TURN_SURVIVES' }, '2026-01-01T00:09:00.000Z'),
    ];
    writeFileSync(p, lines.join('\n') + '\n');

    const r = await runTranscriptsIngest(engine, baseOpts([p], { maxBytes: 64 * 1024 }));
    expect(r.erroredFiles).toBe(0);
    expect(r.sessionsImported).toBe(1);

    const pages = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 10 });
    expect(pages).toHaveLength(1);
    const page = await engine.getPage(pages[0].slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain('NEWEST_TURN_SURVIVES');
    expect(page!.compiled_truth).not.toContain('MIDDLE_TURN_MUST_BE_DROPPED');
  });

  // A truncated read leaves seam partials in skippedLines, which freezes the
  // since:last watermark. Pre-existing behaviour (the old throw froze it too),
  // pinned here so a future change to seam accounting is a deliberate one.
  test('a truncated read is never a clean scan', async () => {
    const p = join(tmp, 'oversized-rollout-2.jsonl');
    const meta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { session_id: 'wired-sess-2', cwd: '/w' },
    });
    const filler = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: { type: 'reasoning', content: 'y'.repeat(4000) },
    });
    const newest = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-01-01T00:09:00.000Z',
      payload: { type: 'user_message', message: 'tail turn' },
    });
    writeFileSync(p, [meta, ...Array(400).fill(filler), newest].join('\n') + '\n');
    const r = await runTranscriptsIngest(engine, baseOpts([p], { maxBytes: 64 * 1024 }));
    expect(r.cleanScan).toBe(false);
  });
});

describe('dry-run', () => {
  test('writes NOTHING — no pages, no raw data — and never advances watermarks', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE], { dryRun: true }));
    expect(r.pages.planned).toBe(1);
    expect(r.pages.imported).toBe(0);
    expect(r.cleanScan).toBe(false); // dry-runs must not advance the watermark
    const pages = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 10 });
    expect(pages).toHaveLength(0);
  });
});

describe('idempotency', () => {
  test('second run hash-skips every page; slugsTouched still includes them (facts re-runs)', async () => {
    const r1 = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE, AGENT_FIXTURE]));
    expect(r1.pages.imported).toBe(2);
    const r2 = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE, AGENT_FIXTURE]));
    expect(r2.pages.imported).toBe(0);
    expect(r2.pages.skipped).toBe(2);
    // The facts lane must see hash-skipped slugs too (CX14).
    expect(r2.slugsTouched.sort()).toEqual(r1.slugsTouched.sort());
  });
});

describe('redaction before write', () => {
  test('planted secret never reaches the page; redaction counted', async () => {
    const p = join(tmp, 'secret-session.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'secret-session-01', timestamp: '2026-08-09T10:00:00.000Z' }),
        JSON.stringify({
          type: 'message',
          id: 'm-1',
          timestamp: '2026-08-09T10:00:01.000Z',
          message: {
            role: 'user',
            timestamp: '2026-08-09T10:00:01.000Z',
            content: [{ type: 'text', text: `the deploy key is ${PLANTED_KEY} keep it safe` }],
          },
        }),
      ].join('\n') + '\n',
    );
    const r = await runTranscriptsIngest(engine, baseOpts([p]));
    expect(r.sessionsImported).toBe(1);
    expect(r.redactions).toBeGreaterThanOrEqual(1);
    const page = await engine.getPage(r.slugsTouched[0], { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).not.toContain(PLANTED_KEY);
    expect(page!.compiled_truth).toContain('<REDACTED:');
  });
});

describe('part splitting + dangerous transitions', () => {
  test('big session splits under the embed-skip threshold and every part is a real page', async () => {
    const p = writeBigAgentSession(tmp, 'bigsession-0001', 150);
    const r = await runTranscriptsIngest(engine, baseOpts([p]));
    expect(r.sessionsImported).toBe(1);
    expect(r.pages.imported).toBeGreaterThan(1);
    expect(r.cleanScan).toBe(true); // pristine synthetic file: clean scan holds
    const base = buildTranscriptSlug('openclaw', '2026-08-10T08:00:00.000Z', {
      sessionId: 'bigsession-0001',
    });
    const p1 = await engine.getPage(base, { sourceId: 'default' });
    const p2 = await engine.getPage(`${base}-p2`, { sourceId: 'default' });
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    // Split pages must stay embeddable: no embed_skip marker on any part.
    for (const page of [p1!, p2!]) {
      const fm = page.frontmatter as Record<string, any>;
      expect(fm.embed_skip).toBeUndefined();
      expect(fm.transcript_import.of).toBe(r.pages.imported);
    }
    // Unique per-part identity (a shared id would dedup-skip parts 2..N).
    expect((p1!.frontmatter as any).id).not.toBe((p2!.frontmatter as any).id);
  });

  test('split → shrink deletes stale higher parts (reconciliation)', async () => {
    const big = writeBigAgentSession(tmp, 'shrinksession-01', 150);
    const r1 = await runTranscriptsIngest(engine, baseOpts([big]));
    const parts = r1.pages.imported;
    expect(parts).toBeGreaterThan(1);
    // Same session id, now tiny: re-render to ONE part.
    const small = writeBigAgentSession(join(tmp), 'shrinksession-01', 2);
    const r2 = await runTranscriptsIngest(engine, baseOpts([small]));
    expect(r2.sessionsImported).toBe(1);
    expect(r2.partsDeleted).toBe(parts - 1);
    const base = buildTranscriptSlug('openclaw', '2026-08-10T08:00:00.000Z', {
      sessionId: 'shrinksession-01',
    });
    expect(await engine.getPage(base, { sourceId: 'default' })).not.toBeNull();
    expect(await engine.getPage(`${base}-p2`, { sourceId: 'default' })).toBeNull();
  });

  test('reconciliation heals crash holes (deleted -p2, surviving -p3)', async () => {
    const big = writeBigAgentSession(tmp, 'holesession-0001', 300);
    const r1 = await runTranscriptsIngest(engine, baseOpts([big]));
    expect(r1.pages.imported).toBeGreaterThan(2); // need at least p3 for the hole
    const base = buildTranscriptSlug('openclaw', '2026-08-10T08:00:00.000Z', {
      sessionId: 'holesession-0001',
    });
    // Simulate a crash mid-reconciliation on a prior shrink: -p2 already
    // deleted, higher parts survive.
    await engine.deletePage(`${base}-p2`, { sourceId: 'default' });
    const small = writeBigAgentSession(join(tmp), 'holesession-0001', 2);
    const r2 = await runTranscriptsIngest(engine, baseOpts([small]));
    expect(r2.sessionsImported).toBe(1);
    // SQL enumeration walks past the -p2 hole and removes every survivor.
    expect(await engine.getPage(`${base}-p3`, { sourceId: 'default' })).toBeNull();
  });
});

describe('since/limit clean-scan semantics', () => {
  test('sinceIso filters old sessions; limit counts NEW WORK; truncation breaks cleanScan', async () => {
    // Two pristine synthetic sessions (no malformed lines → clean scans).
    const a = writeBigAgentSession(tmp, 'sincesession-0001', 2);
    const b = writeBigAgentSession(tmp, 'sincesession-0002', 2);

    // Both are older than the since bound → filtered, clean scan holds.
    const rSince = await runTranscriptsIngest(
      engine,
      baseOpts([a, b], { sinceIso: '2027-01-01T00:00:00.000Z' }),
    );
    expect(rSince.sessionsFiltered).toBe(2);
    expect(rSince.sessionsImported).toBe(0);
    expect(rSince.cleanScan).toBe(true);
    expect(rSince.maxSessionTs > '2026-08-01').toBe(true);

    // limit=1 over two files → truncated, NOT a clean scan (watermark frozen).
    const rLimit = await runTranscriptsIngest(engine, baseOpts([a, b], { limit: 1 }));
    expect(rLimit.sessionsImported).toBe(1);
    expect(rLimit.cleanScan).toBe(false);

    // Kill/rerun convergence WITH the same limit: hash-skipped re-scans are
    // FREE (they don't burn the limit), so run 2 reaches the second session
    // instead of looping over the imported prefix forever.
    const rLimit2 = await runTranscriptsIngest(engine, baseOpts([a, b], { limit: 1 }));
    expect(rLimit2.sessionsImported).toBe(2); // 1 hash-skip + 1 new import
    const rFull = await runTranscriptsIngest(engine, baseOpts([a, b]));
    expect(rFull.pages.imported).toBe(0);
    expect(rFull.pages.skipped).toBe(2);
    expect(rFull.cleanScan).toBe(true);
  });
});

describe('error taxonomy', () => {
  test('unknown-format file is a per-file error; the run continues', async () => {
    const junk = join(tmp, 'junk.jsonl');
    writeFileSync(junk, '{"unrelated":true}\n');
    const r = await runTranscriptsIngest(engine, baseOpts([junk, CODEX_FIXTURE]));
    expect(r.erroredFiles).toBe(1);
    expect(r.sessionsImported).toBe(1);
    expect(r.cleanScan).toBe(false);
  });

  test('zero-session file raises the drift signal', async () => {
    const empty = join(tmp, 'empty.jsonl');
    writeFileSync(
      empty,
      JSON.stringify({ type: 'session', version: 3, id: 'empty-session-1', timestamp: '2026-08-09T10:00:00.000Z' }) + '\n',
    );
    const r = await runTranscriptsIngest(engine, baseOpts([empty], { format: 'openclaw' }));
    expect(r.driftFiles).toBe(1);
    expect(r.sessionsImported).toBe(0);
  });
});

describe('all seven formats travel the FULL pipeline (parse → redact → render → import)', () => {
  test('claude-code: the shipped fixture imports as a page with placeholders and real timestamps', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([CLAUDE_CODE_FIXTURE]));
    expect(r.sessionsImported).toBe(1);
    expect(r.pages.imported).toBe(1);
    const slug = buildTranscriptSlug('claude-code', '2026-08-01T10:00:00.000Z', {
      sessionId: 'fixture-session-1',
    });
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.type).toBe('conversation');
    const fm = page!.frontmatter as Record<string, any>;
    expect(fm.transcript_import.harness).toBe('claude-code');
    expect(fm.date).toBe('2026-08-01');
    // Text turns land; tool traffic appears only as placeholders; the
    // anchor lines carry the fixture's REAL timestamps.
    expect(page!.compiled_truth).toContain("widget-co's seed round");
    expect(page!.compiled_truth).toContain('[tool: search_brain]');
    expect(page!.compiled_truth).toContain('(2026-08-01 10:00 AM)');
  });

  test('hermes: ONE store file yields MANY pages (multi-session ingest path)', async () => {
    const dbPath = buildHermesFixture(tmp);
    const r = await runTranscriptsIngest(engine, baseOpts([dbPath]));
    // 3 sessions in the store; the tool-only one never yields → 2 imported.
    expect(r.sessionsImported).toBe(2);
    expect(r.pages.imported).toBe(2);
    expect(r.cleanScan).toBe(true);
    const s1 = buildTranscriptSlug('hermes', '2026-08-05T08:00:00.000Z', {
      sessionId: 'hermes-fixture-1',
    });
    const s2 = buildTranscriptSlug('hermes', '2026-08-06T08:00:00.000Z', {
      sessionId: 'hermes-fixture-2',
    });
    const p1 = await engine.getPage(s1, { sourceId: 'default' });
    const p2 = await engine.getPage(s2, { sourceId: 'default' });
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    // Title is promoted to the page COLUMN at import (not kept in frontmatter).
    expect(p1!.title).toContain('widget planning');
    // Session 2's JSON block-array contents unwrapped to text in the page.
    expect(p2!.compiled_truth).toContain('acme-seed closes at the end of the month.');
    // Session metadata rode raw_data for BOTH sessions of the one file.
    const raw1 = await engine.getRawData(s1, 'transcript:hermes', { sourceId: 'default' });
    const raw2 = await engine.getRawData(s2, 'transcript:hermes', { sourceId: 'default' });
    expect(raw1.length).toBe(1);
    expect(raw2.length).toBe(1);

    // limit interplay on a multi-session FILE: limit=1 imports one session,
    // truncates cleanly, and the follow-up run converges.
    await resetPgliteState(engine);
    const rLimit = await runTranscriptsIngest(engine, baseOpts([dbPath], { limit: 1 }));
    expect(rLimit.sessionsImported).toBe(1);
    expect(rLimit.cleanScan).toBe(false);
    const rRest = await runTranscriptsIngest(engine, baseOpts([dbPath]));
    expect(rRest.pages.imported + rRest.pages.skipped).toBe(2);
  });

  test('grok: chat_history.jsonl imports text turns; tools/system/synthetic never land', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([GROK_FIXTURE]));
    expect(r.sessionsImported).toBe(1);
    expect(r.pages.imported).toBe(1);
    const slug = buildTranscriptSlug('grok', '2026-08-08T11:00:00.000Z', {
      sessionId: 'grok-fixture-session-1',
    });
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.type).toBe('conversation');
    const fm = page!.frontmatter as Record<string, any>;
    expect(fm.transcript_import.harness).toBe('grok');
    expect(fm.date).toBe('2026-08-08');
    expect(page!.compiled_truth).toContain('Which fund led the widget-co seed');
    expect(page!.compiled_truth).toContain('fund-a led the widget-co seed');
    expect(page!.compiled_truth).not.toContain('SYSTEM-ONLY-TEXT');
    expect(page!.compiled_truth).not.toContain('TOOL-OUTPUT-ONLY-TEXT');
    expect(page!.compiled_truth).not.toContain('SYNTHETIC-ONLY-TEXT');
    const raw = await engine.getRawData(slug, 'transcript:grok', { sourceId: 'default' });
    expect(raw.length).toBe(1);
  });

  test('chatgpt export: one file → per-thread pages under conversations/chatgpt/ with title slugs', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([CHATGPT_FIXTURE]));
    // Conversation 3 is system-only → skipped by the adapter.
    expect(r.sessionsImported).toBe(2);
    expect(r.pages.imported).toBe(2);
    const slug = buildTranscriptSlug('chatgpt', new Date(1786080000 * 1000).toISOString(), {
      sessionId: 'cgpt-conv-0001',
      title: 'Widget launch naming',
    });
    expect(slug).toContain('conversations/chatgpt/');
    expect(slug).toContain('widget-launch-naming');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Widget launch naming');
    // Canonical path only — the abandoned branch never lands in the page.
    expect(page!.compiled_truth).toContain('Call it LaunchPanel.');
    expect(page!.compiled_truth).not.toContain('BRANCH-A-ONLY-TEXT');
  });

  test('claude.ai export: one file → pages under conversations/claude/ with title slugs', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([CLAUDE_EXPORT_FIXTURE]));
    expect(r.sessionsImported).toBe(1);
    expect(r.pages.imported).toBe(1);
    const slug = buildTranscriptSlug('claude-export', '2026-08-07T12:00:00.000Z', {
      sessionId: 'claude-conv-0001',
      title: 'Deal memo review',
    });
    expect(slug).toContain('conversations/claude/');
    expect(slug).toContain('deal-memo-review');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain('fund-a term sheet date');
    const fm = page!.frontmatter as Record<string, any>;
    expect(fm.transcript_import.harness).toBe('claude-export');
  });
});

describe('raw metadata redaction [security: raw rides the REDACTED copy]', () => {
  test('secrets in session metadata never reach raw_data', async () => {
    const p = join(tmp, 'meta-secret.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'meta-secret-01',
          timestamp: '2026-08-09T10:00:00.000Z',
          cwd: `/home/alice/${PLANTED_KEY}-project`,
        }),
        JSON.stringify({
          type: 'message',
          id: 'm-1',
          timestamp: '2026-08-09T10:00:01.000Z',
          message: {
            role: 'user',
            timestamp: '2026-08-09T10:00:01.000Z',
            content: [{ type: 'text', text: 'plain question' }],
          },
        }),
      ].join('\n') + '\n',
    );
    const r = await runTranscriptsIngest(engine, baseOpts([p]));
    expect(r.sessionsImported).toBe(1);
    const raw = await engine.getRawData(r.slugsTouched[0], undefined, { sourceId: 'default' });
    expect(raw.length).toBeGreaterThan(0);
    const stored = JSON.stringify(raw[0].data);
    expect(stored).not.toContain(PLANTED_KEY);
    expect(stored).toContain('<REDACTED:');
  });
});

describe('embed-OFF default', () => {
  test('imported pages carry zero embedded chunks unless embed is opted in', async () => {
    const r = await runTranscriptsIngest(engine, baseOpts([CODEX_FIXTURE]));
    expect(r.pages.imported).toBe(1);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1 AND cc.embedding IS NOT NULL`,
      [r.slugsTouched[0]],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe('discovery + status [injected roots, never the real home]', () => {
  test('discovery filters symlinks/checkpoints; status gap math catches late arrivals', async () => {
    // Fake harness layout: an openclaw agents tree with one real session,
    // one checkpoint sibling, one symlink; plus a codex sessions tree.
    const openclawRoot = join(tmp, 'agents');
    const codexRoot = join(tmp, 'sessions');
    mkdirSync(join(openclawRoot, 'main', 'sessions'), { recursive: true });
    mkdirSync(codexRoot, { recursive: true });
    const realSession = join(openclawRoot, 'main', 'sessions', 'agent-fixture-session-1.jsonl');
    copyFileSync(AGENT_FIXTURE, realSession);
    copyFileSync(
      AGENT_FIXTURE,
      join(openclawRoot, 'main', 'sessions', 'agent-fixture-session-1.checkpoint.aaaa-bbbb.jsonl'),
    );
    symlinkSync(realSession, join(openclawRoot, 'main', 'sessions', 'link.jsonl'));
    copyFileSync(CODEX_FIXTURE, join(codexRoot, 'rollout-codex-fixture-session-1.jsonl'));

    const roots: HarnessRoot[] = [
      { format: 'openclaw', root: openclawRoot, extension: '.jsonl' },
      { format: 'codex', root: codexRoot, extension: '.jsonl' },
    ];
    const discovered = discoverTranscriptFiles(roots);
    // Checkpoint + symlink excluded: one file per harness.
    expect(discovered.map((d) => d.format).sort()).toEqual(['codex', 'openclaw']);

    // Import ONLY the openclaw session; codex stays a gap (late arrival).
    const r = await runTranscriptsIngest(engine, baseOpts([realSession]));
    expect(r.sessionsImported).toBe(1);
    const rows = buildStatusRows(discovered, await indexImportedSessions(engine, 'default'), roots);
    const oc = rows.find((x) => x.format === 'openclaw')!;
    const cx = rows.find((x) => x.format === 'codex')!;
    expect(oc.found).toBe(1);
    expect(oc.importedSessions).toBe(1);
    expect(oc.gapFiles).toBe(0);
    expect(cx.found).toBe(1);
    expect(cx.importedSessions).toBe(0);
    expect(cx.gapFiles).toBe(1); // the watermark-blind late arrival, caught here
  });
});

describe('facts kill-switch pre-check', () => {
  test('facts.extraction_enabled=false skips with a notice result, never a throw', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    try {
      const r = await runIngestFacts(engine, {
        sourceId: 'default',
        slugs: ['conversations/sessions/whatever'],
        quiet: true,
      });
      expect(r.skippedDisabled).toBe(true);
      expect(r.pages).toBe(0);
    } finally {
      await engine.unsetConfig('facts.extraction_enabled');
    }
  });
});

describe('putRawData zero-row parity (PGLite)', () => {
  test('missing page throws instead of silently no-opping', async () => {
    await expect(
      engine.putRawData('conversations/sessions/never-imported', 'transcript:codex', { a: 1 }, { sourceId: 'default' }),
    ).rejects.toThrow(/not found/);
    await expect(
      engine.putRawData('conversations/sessions/never-imported-2', 'transcript:codex', { a: 1 }),
    ).rejects.toThrow(/not found/);
  });
});
