/**
 * v0.31 Phase 6 — Cross-session recall test (PRIMARY ship gate, PGLite).
 *
 * Insert a fact via session A; recall it from session B; the brain
 * remembers across sessions. PGLite in-memory; no DATABASE_URL.
 *
 * Postgres parity in test/e2e/facts-separation-postgres.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE } from '../src/core/facts/audit-sources.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe("Cross-session recall test (PGLite)", () => {
  test('fact inserted in session A is visible from session B (cross-session, same source)', async () => {
    // Earlier session: a user mentions a scheduled event.
    await engine.insertFact(
      {
        fact: 'sample event Tuesday',
        kind: 'event',
        entity_slug: 'travel',
        source: 'mcp:extract_facts',
        source_session: 'session-A',
        visibility: 'world',
      },
      { source_id: 'default' },
    );

    // Later session: the same user asks about their schedule. Recall by
    // entity (cross-session retrieval — session is data, not key).
    const byEntity = await engine.listFactsByEntity('default', 'travel');
    expect(byEntity.length).toBe(1);
    expect(byEntity[0].fact).toBe('sample event Tuesday');
    expect(byEntity[0].source_session).toBe('session-A');

    // Recall by recency (--since "8 hours ago").
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    const bySince = await engine.listFactsSince('default', eightHoursAgo);
    expect(bySince.find(f => f.fact === 'sample event Tuesday')).toBeDefined();

    // Recall by the OLD session id (admin reviewing a session).
    const sessionA = await engine.listFactsBySession('default', 'session-A');
    expect(sessionA.length).toBe(1);

    // Recall by the NEW session id returns nothing — session is data, not
    // a partition. Cross-session continuity comes from entity / since.
    const sessionB = await engine.listFactsBySession('default', 'session-B');
    expect(sessionB.length).toBe(0);
  });

  test('expired facts are hidden from default recall, surfaced via include-expired', async () => {
    const inserted = await engine.insertFact(
      { fact: 'expired fact', kind: 'fact', entity_slug: 'expired-test', source: 'test' },
      { source_id: 'default' },
    );
    await engine.expireFact(inserted.id);

    const active = await engine.listFactsByEntity('default', 'expired-test');
    expect(active.length).toBe(0);
    const all = await engine.listFactsByEntity('default', 'expired-test', { activeOnly: false });
    expect(all.length).toBe(1);
    expect(all[0].expired_at).not.toBeNull();
  });

  // extract-conversation-facts writes durable audit checkpoint rows
  // (source = TERMINAL_AUDIT_SOURCE / NON_EXTRACTABLE_AUDIT_SOURCE) into the
  // facts table to mark batch-run progress. Their created_at is always the
  // most recent write, so for trusted callers (no visibility filter) they
  // dominate the newest-N fetch window right after a batch run and starve
  // recall of real facts. excludeAuditRows keeps them out in SQL, keyed on
  // `source` (the writer), not on the fact TEXT. Postgres parity in
  // test/e2e/facts-separation-postgres.test.ts.
  test('excludeAuditRows filters extraction audit checkpoint rows out of listFactsSince', async () => {
    const before = new Date();
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: TERMINAL_AUDIT_SOURCE,
        source_session: 'audit-checkpoint-session',
        notability: 'low',
      },
      { source_id: 'default' },
    );
    await engine.insertFact(
      {
        fact: 'EXTRACTION_NOT_APPLICABLE',
        kind: 'fact',
        entity_slug: null,
        source: NON_EXTRACTABLE_AUDIT_SOURCE,
        source_session: 'audit-checkpoint-session',
        notability: 'low',
      },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'real user fact about travel plans', kind: 'fact', entity_slug: 'travel', source: 'test' },
      { source_id: 'default' },
    );

    // Default behavior (no excludeAuditRows) is unchanged: audit rows still
    // come back, same as before this PR.
    const withAudit = await engine.listFactsSince('default', before);
    expect(withAudit.some(r => r.source === TERMINAL_AUDIT_SOURCE)).toBe(true);
    expect(withAudit.some(r => r.source === NON_EXTRACTABLE_AUDIT_SOURCE)).toBe(true);
    expect(withAudit.some(r => r.fact === 'real user fact about travel plans')).toBe(true);

    // excludeAuditRows: true strips rows written by either audit source,
    // real facts remain.
    const withoutAudit = await engine.listFactsSince('default', before, { excludeAuditRows: true });
    expect(withoutAudit.some(r => r.source === TERMINAL_AUDIT_SOURCE)).toBe(false);
    expect(withoutAudit.some(r => r.source === NON_EXTRACTABLE_AUDIT_SOURCE)).toBe(false);
    expect(withoutAudit.some(r => r.fact === 'real user fact about travel plans')).toBe(true);
  });

  // The predicate is keyed on the writer (`source`), not the fact TEXT — so
  // a genuine user fact whose text happens to be EXACTLY one of the audit
  // marker strings must NOT be excluded. Pre-fix, the predicate was
  // `fact NOT IN ('EXTRACTION_COMPLETE', 'EXTRACTION_NOT_APPLICABLE')` —
  // matching on fact TEXT — which hid this legitimate content; this is the
  // crowd-out case that motivated moving the predicate to `source`. (A
  // substring/partial match was never at risk either way: `NOT IN` and
  // `source != ALL(...)` are both exact-match.)
  test('excludeAuditRows only excludes audit-SOURCED rows — a real fact whose exact text matches an audit marker string survives', async () => {
    const before = new Date();
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: 'tracker-naming',
        source: 'test',
      },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsSince('default', before, { excludeAuditRows: true });
    expect(rows.some(r => r.fact === 'EXTRACTION_COMPLETE' && r.source === 'test')).toBe(true);
  });

  // excludeAuditRows is honored consistently across all three FactListOpts
  // consumers (listFactsSince above, listFactsByEntity + listFactsBySession
  // here) — not silently ignored on the shared options bag. Also re-proves
  // the source-vs-text distinction at these two call sites specifically.
  test('excludeAuditRows also filters listFactsByEntity and listFactsBySession, keyed on source not fact text', async () => {
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: 'audit-entity-scope-test',
        source: TERMINAL_AUDIT_SOURCE,
        source_session: 'audit-entity-scope-session',
      },
      { source_id: 'default' },
    );
    await engine.insertFact(
      {
        // Same fact TEXT as the audit-sourced row above, but a normal
        // source — a real user fact that must survive exclusion.
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: 'audit-entity-scope-test',
        source: 'test',
        source_session: 'audit-entity-scope-session',
      },
      { source_id: 'default' },
    );
    await engine.insertFact(
      {
        fact: 'real fact under the same entity/session',
        kind: 'fact',
        entity_slug: 'audit-entity-scope-test',
        source: 'test',
        source_session: 'audit-entity-scope-session',
      },
      { source_id: 'default' },
    );

    const byEntity = await engine.listFactsByEntity('default', 'audit-entity-scope-test', {
      excludeAuditRows: true,
    });
    expect(byEntity.some(r => r.source === TERMINAL_AUDIT_SOURCE)).toBe(false);
    expect(byEntity.some(r => r.fact === 'EXTRACTION_COMPLETE' && r.source === 'test')).toBe(true);
    expect(byEntity.some(r => r.fact === 'real fact under the same entity/session')).toBe(true);

    const bySession = await engine.listFactsBySession('default', 'audit-entity-scope-session', {
      excludeAuditRows: true,
    });
    expect(bySession.some(r => r.source === TERMINAL_AUDIT_SOURCE)).toBe(false);
    expect(bySession.some(r => r.fact === 'EXTRACTION_COMPLETE' && r.source === 'test')).toBe(true);
    expect(bySession.some(r => r.fact === 'real fact under the same entity/session')).toBe(true);
  });
});
