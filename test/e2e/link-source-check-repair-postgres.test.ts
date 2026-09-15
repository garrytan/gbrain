/**
 * Postgres-only pin for the links_link_source_check self-heal's DDL shape (#4613).
 *
 * On real Postgres a plain `ADD CONSTRAINT ... CHECK` takes ACCESS EXCLUSIVE
 * plus a full validation scan on `links`. The repair must use migration
 * v114's two-phase form — DROP + `ADD ... NOT VALID` in one transaction, then
 * `VALIDATE CONSTRAINT` as a separate statement outside it — validate-only
 * when the definition is right but NOT VALID, and never attempt DDL while
 * violating rows exist. PGLite cannot observe lock semantics (and keeps the
 * one-shot form), so this is DATABASE_URL-gated per the engine-parity
 * convention.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  LINK_SOURCE_KEBAB_RE,
  checkLinkSourceCheck,
  repairLinkSourceCheck,
} from '../../src/core/link-source-check-repair.ts';
import { recordingEngine } from '../helpers/recording-engine.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;

const KEBAB_CHECK =
  `CHECK (link_source IS NULL OR (link_source ~ '${LINK_SOURCE_KEBAB_RE}' AND char_length(link_source) <= 64))`;

const ddlCalls = (calls: string[]) => calls.filter(c => /^(transaction:|runMigration:)/.test(c));

async function dropConstraint(): Promise<void> {
  await engine.executeRaw(`ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check`);
}

async function constraintRow(): Promise<{ def: string; convalidated: boolean } | undefined> {
  const rows = await engine.executeRaw<{ def: string; convalidated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
      WHERE conrelid = to_regclass('links') AND conname = 'links_link_source_check'`,
  );
  return rows[0];
}

beforeAll(async () => {
  if (skip) return;
  engine = await setupDB();
  for (const slug of ['notes/alpha-example', 'notes/beta-example']) {
    await engine.putPage(slug, {
      title: slug, type: 'concept', frontmatter: {}, compiled_truth: `body ${slug}`, timeline: '',
    });
  }
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  await engine.executeRaw(`DELETE FROM links`);
  await repairLinkSourceCheck(engine); // restore the canonical gate before each case
});

describeIfDB('repairLinkSourceCheck on Postgres (#4613)', () => {
  test('wrong_def: DROP + ADD ... NOT VALID in one transaction, VALIDATE CONSTRAINT outside it', async () => {
    await dropConstraint();
    await engine.executeRaw(
      `ALTER TABLE links ADD CONSTRAINT links_link_source_check CHECK (link_source IS NULL OR link_source IN ('markdown'))`,
    );
    expect((await checkLinkSourceCheck(engine)).drift).toBe('wrong_def');

    const rec = recordingEngine(engine);
    const r = await repairLinkSourceCheck(rec.engine);
    expect(r.reason).toBe('restored');

    const ddl = ddlCalls(rec.calls);
    expect(ddl.length).toBe(3);
    expect(ddl[0]).toBe('transaction:');
    expect(ddl[1]).toMatch(/^runMigration:ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check; ALTER TABLE links ADD CONSTRAINT links_link_source_check CHECK .* NOT VALID;$/);
    expect(ddl[1]).not.toContain('VALIDATE');
    expect(ddl[2]).toBe('runMigration:ALTER TABLE links VALIDATE CONSTRAINT links_link_source_check');

    const row = await constraintRow();
    expect(row?.def).toContain(LINK_SOURCE_KEBAB_RE);
    expect(row?.convalidated).toBe(true);
  });

  test('absent: same two-phase form, ends validated', async () => {
    await dropConstraint();
    const rec = recordingEngine(engine);
    const r = await repairLinkSourceCheck(rec.engine);
    expect(r.reason).toBe('restored');
    const ddl = ddlCalls(rec.calls);
    expect(ddl[0]).toBe('transaction:');
    expect(ddl[1]).toContain('NOT VALID');
    expect(ddl[2]).toContain('VALIDATE CONSTRAINT');
    expect((await constraintRow())?.convalidated).toBe(true);
  });

  test('not_validated: VALIDATE CONSTRAINT only — no DROP, no transaction', async () => {
    await dropConstraint();
    await engine.executeRaw(`ALTER TABLE links ADD CONSTRAINT links_link_source_check ${KEBAB_CHECK} NOT VALID`);
    expect((await checkLinkSourceCheck(engine)).drift).toBe('not_validated');

    const rec = recordingEngine(engine);
    const r = await repairLinkSourceCheck(rec.engine);
    expect(r.reason).toBe('restored');
    expect(ddlCalls(rec.calls)).toEqual(['runMigration:ALTER TABLE links VALIDATE CONSTRAINT links_link_source_check']);
    expect((await constraintRow())?.convalidated).toBe(true);
  });

  test('violating rows: reported, no DDL attempted, prior constraint untouched', async () => {
    await dropConstraint();
    await engine.executeRaw(
      `ALTER TABLE links ADD CONSTRAINT links_link_source_check CHECK (link_source IS NULL OR link_source IN ('markdown', 'BAD_TAG'))`,
    );
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
       SELECT a.id, b.id, '', '', 'BAD_TAG' FROM pages a, pages b
        WHERE a.slug = 'notes/alpha-example' AND b.slug = 'notes/beta-example'`,
    );
    const rec = recordingEngine(engine);
    const r = await repairLinkSourceCheck(rec.engine);
    expect(r).toEqual({ repaired: false, violations: 1, reason: 'violations' });
    expect(ddlCalls(rec.calls)).toEqual([]);
    expect(rec.calls.some(c => c.includes('ALTER TABLE'))).toBe(false);
    expect((await constraintRow())?.def).toContain('BAD_TAG');
  });
});
