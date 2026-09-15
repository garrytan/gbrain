/**
 * #4613 — links_link_source_check constraint-shape self-heal.
 *
 * Repro chain pinned here: a fully-migrated brain (ledger >= v114) whose
 * `links_link_source_check` reverted to the pre-v114 closed allowlist rejects
 * every kebab provenance tag ('atom-provenance', 'concept-provenance') while
 * `runMigrations` sees nothing pending and doctor reports the schema current.
 * The repair module probes the constraint SHAPE via pg_constraint (same drift
 * class as #2038 / #550), restores the v114 definition on every migrate pass,
 * and doctor names the drift.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runMigrations, MIGRATIONS } from '../src/core/migrate.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import {
  LINK_SOURCE_KEBAB_RE,
  checkLinkSourceCheck,
  repairLinkSourceCheck,
} from '../src/core/link-source-check-repair.ts';
import { linkSourceCheckConstraintCheck } from '../src/commands/doctor/checks/core-health.ts';
import { recordingEngine } from './helpers/recording-engine.ts';

let engine: PGLiteEngine;

/** The literal v113 predicate — the drift shape reported in #4613. */
const V113_ALLOWLIST_DDL =
  `ALTER TABLE links ADD CONSTRAINT links_link_source_check ` +
  `CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual', 'mentions', 'wikilink-resolved'))`;

/** v114's definition left NOT VALID (an interrupted two-phase Postgres migration). */
const V114_NOT_VALID_DDL =
  `ALTER TABLE links ADD CONSTRAINT links_link_source_check ` +
  `CHECK (link_source IS NULL OR (link_source ~ '${LINK_SOURCE_KEBAB_RE}' AND char_length(link_source) <= 64)) NOT VALID`;

const isDdl = (call: string) => /^(transaction:|runMigration:)|ALTER TABLE/.test(call);

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
  // Restore the canonical constraint in case a prior test drifted it.
  await repairLinkSourceCheck(engine);
  for (const slug of ['notes/alpha-example', 'notes/beta-example']) {
    await engine.putPage(slug, {
      title: slug, type: 'concept', frontmatter: {}, compiled_truth: `body ${slug}`, timeline: '',
    });
  }
});

async function dropConstraint(): Promise<void> {
  await engine.executeRaw(`ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check`);
}

async function driftToV113(): Promise<void> {
  await dropConstraint();
  await engine.executeRaw(V113_ALLOWLIST_DDL);
}

async function addKebabLink(): Promise<void> {
  await engine.addLinksBatch([{
    from_slug: 'notes/alpha-example',
    to_slug: 'notes/beta-example',
    link_source: 'atom-provenance',
    from_source_id: 'default',
    to_source_id: 'default',
  }]);
}

async function constraintRow(): Promise<{ def: string; convalidated: boolean } | undefined> {
  const rows = await engine.executeRaw<{ def: string; convalidated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
      WHERE conrelid = to_regclass('links') AND conname = 'links_link_source_check'`,
  );
  return rows[0];
}

describe('runMigrations self-heal (#4613)', () => {
  test('a ledger-current brain with the v113 allowlist heals on a nothing-pending pass', async () => {
    // Stamp the ledger fully-migrated first (resetPgliteState clears config):
    // the drift must heal on a NO-PENDING pass.
    await runMigrations(engine);
    await driftToV113();
    await expect(addKebabLink()).rejects.toThrow(/check constraint/i);

    const out = await runMigrations(engine);
    expect(out.applied).toBe(0); // nothing pending — the self-heal ran anyway

    await addKebabLink();
    const n = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links WHERE link_source = 'atom-provenance'`,
    );
    expect(parseInt(n[0].n, 10)).toBe(1);
    expect((await constraintRow())?.def).toContain(LINK_SOURCE_KEBAB_RE);
  });

  test('ledger below v114: the self-heal is skipped and v114 itself installs the gate (no double rewrite)', async () => {
    // A pre-v114 brain has the v113 allowlist legitimately — the pending loop
    // replays v114. Running the repair first would rewrite the constraint
    // twice (and on a pre-v11 brain with no link_source column, print a
    // spurious self-heal error).
    await engine.setConfig('version', '113');
    await driftToV113();
    const rec = recordingEngine(engine);
    const out = await runMigrations(rec.engine);
    expect(out.applied).toBeGreaterThan(0);
    expect(rec.calls.filter(c => c.includes(`conname = 'links_link_source_check'`))).toEqual([]);
    const row = await constraintRow();
    expect(row?.def).toContain(LINK_SOURCE_KEBAB_RE);
    expect(row?.convalidated).toBe(true);
  });
});

describe('checkLinkSourceCheck / repairLinkSourceCheck (#4613)', () => {
  test('healthy brain: no repair needed, repair is a no-op that leaves the def untouched', async () => {
    const before = await constraintRow();
    expect(before?.def).toContain(LINK_SOURCE_KEBAB_RE);
    const status = await checkLinkSourceCheck(engine);
    expect(status.tablePresent).toBe(true);
    expect(status.needsRepair).toBe(false);
    expect(status.drift).toBeNull();

    const r = await repairLinkSourceCheck(engine);
    expect(r.reason).toBe('already_correct');
    expect(r.repaired).toBe(false);
    expect((await constraintRow())?.def).toBe(before!.def);
  });

  test('v113 allowlist → drift wrong_def → restored', async () => {
    await driftToV113();
    const status = await checkLinkSourceCheck(engine);
    expect(status.needsRepair).toBe(true);
    expect(status.drift).toBe('wrong_def');

    const r = await repairLinkSourceCheck(engine);
    expect(r.reason).toBe('restored');
    expect(r.repaired).toBe(true);
    expect((await checkLinkSourceCheck(engine)).needsRepair).toBe(false);
    expect((await constraintRow())?.convalidated).toBe(true);
    await addKebabLink();
  });

  test('absent constraint → drift absent → restored', async () => {
    await dropConstraint();
    const status = await checkLinkSourceCheck(engine);
    expect(status.constraintPresent).toBe(false);
    expect(status.drift).toBe('absent');
    expect(status.needsRepair).toBe(true);

    const r = await repairLinkSourceCheck(engine);
    expect(r.reason).toBe('restored');
    expect((await constraintRow())?.def).toContain(LINK_SOURCE_KEBAB_RE);
  });

  test('v114 def left NOT VALID → drift not_validated → restored + validated', async () => {
    await dropConstraint();
    await engine.executeRaw(V114_NOT_VALID_DDL);
    const status = await checkLinkSourceCheck(engine);
    expect(status.drift).toBe('not_validated');
    expect(status.needsRepair).toBe(true);

    const r = await repairLinkSourceCheck(engine);
    expect(r.reason).toBe('restored');
    expect(r.repaired).toBe(true);
    const row = await constraintRow();
    expect(row?.def).toContain(LINK_SOURCE_KEBAB_RE);
    expect(row?.convalidated).toBe(true);
    expect((await checkLinkSourceCheck(engine)).needsRepair).toBe(false);
  });

  test('pre-existing violating rows: repair refuses loudly WITHOUT attempting any DDL', async () => {
    await dropConstraint();
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
       SELECT a.id, b.id, '', '', 'BAD_TAG' FROM pages a, pages b
        WHERE a.slug = 'notes/alpha-example' AND b.slug = 'notes/beta-example'`,
    );
    const rec = recordingEngine(engine);
    const r = await repairLinkSourceCheck(rec.engine);
    expect(r.reason).toBe('violations');
    expect(r.repaired).toBe(false);
    expect(r.violations).toBe(1);
    // Violators are probed FIRST: no transaction, no ALTER TABLE — on Postgres
    // a failing ADD would otherwise take ACCESS EXCLUSIVE + a full scan on
    // every engine open until a human edits rows.
    expect(rec.calls.filter(isDdl)).toEqual([]);
    expect(await constraintRow()).toBeUndefined();
    expect((await checkLinkSourceCheck(engine)).drift).toBe('absent');
  });
});

describe('doctor links_link_source_check (#4613)', () => {
  test('ok on a healthy brain', async () => {
    const check = await linkSourceCheckConstraintCheck(engine);
    expect(check.name).toBe('links_link_source_check');
    expect(check.status).toBe('ok');
  });

  test('fail when the def lacks the kebab regex (kebab writes are rejected)', async () => {
    await driftToV113();
    const check = await linkSourceCheckConstraintCheck(engine);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('atom-provenance');
    expect(check.message).toContain('gbrain apply-migrations --yes');
  });

  test('warn (not fail) when the constraint is absent — writes still succeed', async () => {
    await dropConstraint();
    const check = await linkSourceCheckConstraintCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('absent');
    await addKebabLink(); // no gate → the write goes through
  });

  test('warn (not fail) when the constraint is NOT VALID — the gate is live, only old rows are unchecked', async () => {
    await dropConstraint();
    await engine.executeRaw(V114_NOT_VALID_DDL);
    const check = await linkSourceCheckConstraintCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('NOT VALID');
    await addKebabLink(); // the kebab gate accepts kebab writes even while NOT VALID
  });

  test('warn on a probe error, never a false ok', async () => {
    const broken = { executeRaw: async () => { throw new Error('boom'); } } as unknown as PGLiteEngine;
    const check = await linkSourceCheckConstraintCheck(broken);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Could not check');
  });
});

describe('regex literal drift guard (#4613)', () => {
  test('LINK_SOURCE_KEBAB_RE matches migration v114, pglite-schema.ts and schema.sql verbatim', () => {
    const m = MIGRATIONS.find(x => x.version === 114)!;
    expect(m.name).toBe('links_link_source_check_kebab_regex');
    const needle = `link_source ~ '${LINK_SOURCE_KEBAB_RE}'`;
    expect(m.sqlFor!.pglite!).toContain(needle);
    expect(m.sqlFor!.postgres!).toContain(needle);
    expect(PGLITE_SCHEMA_SQL).toContain(needle);
    const schemaSql = readFileSync(join(import.meta.dir, '..', 'src', 'schema.sql'), 'utf8');
    expect(schemaSql).toContain(needle);
  });
});
