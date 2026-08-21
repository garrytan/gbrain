/**
 * recall (MCP op) + `gbrain recall` (CLI) — audit checkpoint rows are
 * excluded from output.
 *
 * extract-conversation-facts writes durable audit checkpoint rows — source
 * TERMINAL_AUDIT_SOURCE / NON_EXTRACTABLE_AUDIT_SOURCE
 * (src/core/facts/audit-sources.ts) — into the facts table to mark
 * batch-run progress. Their created_at is always the most recent write, so
 * right after a batch run they dominate the newest-N fetch window that
 * trusted (remote=false / local CLI) callers hit — recall returns audit
 * rows instead of real facts.
 *
 * The exclusion predicate is keyed on `source` (the writer), not on the
 * fact TEXT — a real fact whose text happens to equal one of the audit
 * marker strings must still come back. See the 'EXTRACTION_COMPLETE'/source:
 * 'test' row seeded in beforeAll and asserted present in every test below.
 *
 * This exercises the fix at BOTH trusted read surfaces:
 *   - the MCP `recall` op handler (src/core/operations.ts) via
 *     dispatchToolCall, and
 *   - the `gbrain recall` CLI's local (non-thin-client) path
 *     (src/commands/recall.ts `fetchRowsLocal`), which calls the engine
 *     directly and does NOT go through the op handler — so it needed its
 *     own excludeAuditRows wiring, not just operations.ts.
 *
 * Engine-level parity coverage lives in test/facts-separation-pglite.test.ts
 * + test/e2e/facts-separation-postgres.test.ts.
 *
 * PGLite-only; no DATABASE_URL required.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runRecall } from '../src/commands/recall.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE, LEGACY_TERMINAL_AUDIT_SOURCE } from '../src/core/facts/audit-sources.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed order matters: the real fact goes in FIRST (older created_at), then
  // the audit checkpoint rows go in AFTER (newer created_at) — mirroring
  // real production order, where extract-conversation-facts writes its
  // terminal audit row only after processing (and inserting facts for) a
  // batch of pages. With ORDER BY created_at DESC, id DESC, this makes the
  // audit rows occupy the newest-N window and the real fact fall OUTSIDE a
  // small limit — the exact crowd-out failure mode this PR fixes. (Seeding
  // audit rows before the real fact, as an earlier draft of this test did,
  // makes the real fact newest and the test passes even without the SQL-
  // level fix — non-discriminative.)
  await engine.insertFact(
    {
      fact: 'the user prefers oat milk in their coffee',
      kind: 'preference',
      entity_slug: 'coffee-prefs',
      source: 'test',
      visibility: 'world',
    },
    { source_id: 'default' },
  );
  // A genuine user fact whose TEXT happens to be exactly the audit marker
  // string, but written by a normal (non-audit) source. This is the case
  // the OLD `fact NOT IN ('EXTRACTION_COMPLETE', ...)` predicate got wrong
  // — it matched on fact TEXT and hid this real content. The fix keys the
  // predicate on `source` instead, so this row must survive exclusion.
  await engine.insertFact(
    {
      fact: 'EXTRACTION_COMPLETE',
      kind: 'fact',
      entity_slug: 'coffee-prefs',
      source: 'test',
      visibility: 'world',
    },
    { source_id: 'default' },
  );
  for (let i = 0; i < 5; i++) {
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: TERMINAL_AUDIT_SOURCE,
        source_session: `audit-batch-${i}`,
        notability: 'low',
      },
      { source_id: 'default' },
    );
  }
  await engine.insertFact(
    {
      fact: 'EXTRACTION_NOT_APPLICABLE',
      kind: 'fact',
      entity_slug: null,
      source: NON_EXTRACTABLE_AUDIT_SOURCE,
      source_session: 'audit-batch-na',
      notability: 'low',
    },
    { source_id: 'default' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall op excludes extract-conversation-facts audit rows', () => {
  test('recall with limit smaller than the audit-row count still surfaces the real fact (since arm)', async () => {
    // limit=3 is smaller than the 6 audit rows seeded above (and they are
    // ALL newer than the real fact per the seed order in beforeAll) —
    // pre-fix, ORDER BY created_at DESC LIMIT 3 returns only audit rows and
    // the real fact never appears. Post-fix, excludeAuditRows removes them
    // from the SQL result set before LIMIT is applied.
    const result = await dispatchToolCall(
      engine,
      'recall',
      { since: '1 hour ago', limit: 3 },
      { remote: false, sourceId: 'default' },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    const facts: Array<{ fact: string; source: string }> = payload.facts;
    expect(facts.some(f => f.source === TERMINAL_AUDIT_SOURCE)).toBe(false);
    expect(facts.some(f => f.source === NON_EXTRACTABLE_AUDIT_SOURCE)).toBe(false);
    expect(facts.some(f => f.fact === 'the user prefers oat milk in their coffee')).toBe(true);
    // The real fact whose TEXT equals the audit marker, but whose source is
    // normal, must NOT be excluded — this is what a text-based predicate
    // would get wrong.
    expect(facts.some(f => f.fact === 'EXTRACTION_COMPLETE' && f.source === 'test')).toBe(true);
  });

  test('recall with no filter (default recent-across-source arm) excludes audit rows', async () => {
    const result = await dispatchToolCall(
      engine,
      'recall',
      { limit: 3 },
      { remote: false, sourceId: 'default' },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    const facts: Array<{ fact: string; source: string }> = payload.facts;
    expect(facts.some(f => f.source === TERMINAL_AUDIT_SOURCE)).toBe(false);
    expect(facts.some(f => f.source === NON_EXTRACTABLE_AUDIT_SOURCE)).toBe(false);
    expect(facts.some(f => f.fact === 'the user prefers oat milk in their coffee')).toBe(true);
    expect(facts.some(f => f.fact === 'EXTRACTION_COMPLETE' && f.source === 'test')).toBe(true);
  });

  // Production audit rows are always written with the default (private)
  // visibility, so a remote (world-only) caller already can't see them via
  // the visibility filter alone — that would make a remote-arm test using
  // the shared beforeAll corpus non-discriminative for excludeAuditRows
  // specifically. This test seeds its OWN world-visible audit-shaped row to
  // prove exclusion doesn't depend on visibility (defense in depth: if a
  // future change ever made audit rows world-visible, this still holds).
  test('remote=true (world-only visibility) excludes audit rows even when they are world-visible', async () => {
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: TERMINAL_AUDIT_SOURCE,
        source_session: 'audit-world-visible-probe',
        notability: 'low',
        visibility: 'world',
      },
      { source_id: 'default' },
    );
    const result = await dispatchToolCall(
      engine,
      'recall',
      { since: '1 hour ago', limit: 10 },
      { remote: true, sourceId: 'default' },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    const facts: Array<{ fact: string; source: string }> = payload.facts;
    expect(facts.some(f => f.source === TERMINAL_AUDIT_SOURCE)).toBe(false);
    expect(facts.some(f => f.fact === 'the user prefers oat milk in their coffee')).toBe(true);
    expect(facts.some(f => f.fact === 'EXTRACTION_COMPLETE' && f.source === 'test')).toBe(true);
  });
});

describe('gbrain recall CLI (local, non-thin-client path) excludes audit rows', () => {
  const origWrite = process.stdout.write.bind(process.stdout);

  test('runRecall --json --limit 3 surfaces the real fact, not the audit rows', async () => {
    // fetchRowsLocal (src/commands/recall.ts) calls engine.listFactsSince
    // directly — it does NOT go through the operations.ts `recall` handler,
    // so it needed its own excludeAuditRows: true wiring. This is the
    // Critical-severity gap this test pins.
    //
    // runRecall's local-vs-thin-client branch depends on loadConfig() /
    // isThinClient(), which reads the REAL ~/.gbrain/config.json (via
    // configDir(), GBRAIN_HOME-overridable) — on a dev machine configured as
    // a thin client (remote_mcp set), this test would silently switch to
    // callRemoteTool() and never exercise fetchRowsLocal at all. GBRAIN_HOME
    // -> emptyHome() forces loadConfig() to see no config file, so
    // isThinClient() is deterministically false here. Canonical isolation
    // pattern for this repo (test/helpers/with-env.ts).
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
        await runRecall(engine, ['--json', '--limit', '3']);
      });
    } finally {
      process.stdout.write = origWrite;
    }
    const payload = JSON.parse(captured.trim());
    const facts: Array<{ fact: string; source: string }> = payload.facts;
    expect(facts.some(f => f.source === TERMINAL_AUDIT_SOURCE)).toBe(false);
    expect(facts.some(f => f.source === NON_EXTRACTABLE_AUDIT_SOURCE)).toBe(false);
    expect(facts.some(f => f.fact === 'the user prefers oat milk in their coffee')).toBe(true);
    expect(facts.some(f => f.fact === 'EXTRACTION_COMPLETE' && f.source === 'test')).toBe(true);
  });
});

// Post-review fix: AUDIT_ROW_SOURCES omitted the pre-`:v2` spelling of
// TERMINAL_AUDIT_SOURCE. src/core/migrate.ts's doctor-backlog-index comment
// and test/extract-conversation-facts.test.ts ("legacy terminal rows do not
// suppress strict v2 replay") both reference this exact legacy string, so
// brains upgraded through the pre-v2 checkpoint scheme can still carry rows
// under it — and those rows crowded out real facts the same way the current
// spelling did before this PR's fix, because the recall-side exclusion never
// matched them.
describe('post-review fix: legacy (pre-v2) terminal audit rows are also excluded', () => {
  let engine2: PGLiteEngine;

  beforeAll(async () => {
    engine2 = new PGLiteEngine();
    await engine2.connect({});
    await engine2.initSchema();

    await engine2.insertFact(
      { fact: 'the user prefers oat milk in their coffee', kind: 'preference', entity_slug: 'coffee-prefs', source: 'test', visibility: 'world' },
      { source_id: 'default' },
    );
    for (let i = 0; i < 5; i++) {
      await engine2.insertFact(
        { fact: 'EXTRACTION_COMPLETE', kind: 'fact', entity_slug: null, source: LEGACY_TERMINAL_AUDIT_SOURCE, source_session: `legacy-audit-batch-${i}`, notability: 'low' },
        { source_id: 'default' },
      );
    }
  });

  afterAll(async () => {
    await engine2.disconnect();
  });

  test('legacy-source audit rows do not crowd out the real fact (recall op, since arm)', async () => {
    const result = await dispatchToolCall(
      engine2,
      'recall',
      { since: '1 hour ago', limit: 3 },
      { remote: false, sourceId: 'default' },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    const facts: Array<{ fact: string; source: string }> = payload.facts;
    expect(facts.some(f => f.source === LEGACY_TERMINAL_AUDIT_SOURCE)).toBe(false);
    expect(facts.some(f => f.fact === 'the user prefers oat milk in their coffee')).toBe(true);
  });
});
