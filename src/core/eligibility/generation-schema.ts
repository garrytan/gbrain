/**
 * The trust policy generation counter in the database (#5575 ENG-11). One
 * canonical copy used by the trust generation schema migration. Like the
 * trust tier DDL (trust/schema.ts) it is not in the schema blob: its triggers
 * read `trust_tier` and `min_trust`, which exist only through migrations, so
 * a fresh install gets it by replaying migrations.
 *
 * `trust_policy_state` holds one row whose `generation` increases whenever a
 * change could make cached proactive content (hot memory, OpenClaw core)
 * wrong: a row's trust tier changes; a page enters or leaves quarantine (or a
 * quarantined page is inserted, deleted, soft-deleted, restored or renamed,
 * which moves the facts its slug hides); a token or client read floor
 * changes; a `trust.%` config key is written; a purge ledger or
 * needs_rederive row is inserted. Ordinary writes never touch it: every
 * trigger is WHEN-guarded.
 *
 * A transactional row on purpose, not a sequence: the bump commits with the
 * content change, so a reader that reads the generation BEFORE the content
 * (eligibility/generation.ts) can only cache content at least as new as the
 * generation it stored, and the next read sees a newer generation and
 * rebuilds. The triggers are deferred constraint triggers, so the counter row
 * is locked once per transaction at commit, after every other row lock the
 * transaction takes: two transactions cannot deadlock on it, and a bulk tier
 * change (backfill) updates it once (`gbrain.trust_generation_bumped`).
 */
import { QUARANTINE_KEY } from '../quarantine.ts';

export const TRUST_POLICY_STATE_TABLE = 'trust_policy_state';
export const TRUST_GENERATION_FUNCTION = 'gbrain_bump_trust_generation';
/** Trigger names, one per event (a WHEN clause cannot name OLD on INSERT or NEW on DELETE). */
export const TRUST_GENERATION_TRIGGERS = { insert: 'trust_generation_insert', update: 'trust_generation_update', delete: 'trust_generation_delete' } as const;

type GenerationEvent = keyof typeof TRUST_GENERATION_TRIGGERS;

const quarantined = (row: 'NEW' | 'OLD') => `(COALESCE(${row}.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}')`;

/**
 * table -> event -> WHEN predicate. Pinned by test/trust-generation.test.ts,
 * which checks every listed transition bumps and an ordinary write does not.
 */
export const TRUST_GENERATION_WHEN: Readonly<Record<string, Partial<Record<GenerationEvent, string>>>> = {
  facts: { update: 'OLD.trust_tier IS DISTINCT FROM NEW.trust_tier' },
  takes: { update: 'OLD.trust_tier IS DISTINCT FROM NEW.trust_tier' },
  timeline_entries: { update: 'OLD.trust_tier IS DISTINCT FROM NEW.trust_tier' },
  pages: {
    insert: quarantined('NEW'),
    update: `OLD.trust_tier IS DISTINCT FROM NEW.trust_tier OR ${quarantined('OLD')} IS DISTINCT FROM ${quarantined('NEW')}
      OR (${quarantined('NEW')} AND (OLD.deleted_at, OLD.source_id, OLD.slug) IS DISTINCT FROM (NEW.deleted_at, NEW.source_id, NEW.slug))`,
    delete: quarantined('OLD'),
  },
  oauth_clients: { update: 'OLD.min_trust IS DISTINCT FROM NEW.min_trust' },
  access_tokens: { update: 'OLD.min_trust IS DISTINCT FROM NEW.min_trust' },
  config: {
    insert: `NEW.key LIKE 'trust.%'`,
    update: `(OLD.key LIKE 'trust.%' OR NEW.key LIKE 'trust.%') AND (OLD.key, OLD.value) IS DISTINCT FROM (NEW.key, NEW.value)`,
    delete: `OLD.key LIKE 'trust.%'`,
  },
  fact_purges: { insert: 'TRUE' },
  take_purges: { insert: 'TRUE' },
  page_purges: { insert: 'TRUE' },
  // A new or changed flag receipt changes what activation control withholds (CEO-20).
  write_gate_receipts: {
    insert: 'TRUE',
    update: '(OLD.verdict, OLD.reason_families, OLD.content_hash, OLD.target_table, OLD.target_id) IS DISTINCT FROM (NEW.verdict, NEW.reason_families, NEW.content_hash, NEW.target_table, NEW.target_id)',
    delete: 'TRUE',
  },
  needs_rederive: { insert: 'TRUE' },
};

const BUMP_FUNCTION = `CREATE OR REPLACE FUNCTION ${TRUST_GENERATION_FUNCTION}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF COALESCE(current_setting('gbrain.trust_generation_bumped', true), '') = 'on' THEN RETURN NULL; END IF;
  INSERT INTO ${TRUST_POLICY_STATE_TABLE} (id, generation, bumped_at) VALUES (1, 1, now())
    ON CONFLICT (id) DO UPDATE SET generation = ${TRUST_POLICY_STATE_TABLE}.generation + 1, bumped_at = now();
  PERFORM set_config('gbrain.trust_generation_bumped', 'on', true);
  RETURN NULL;
END $fn$`;

/** DROP + CREATE one deferred, WHEN-guarded row trigger (idempotent). */
export function trustGenerationTriggerSql(table: string, event: GenerationEvent, when: string): string[] {
  const name = TRUST_GENERATION_TRIGGERS[event];
  return [
    `DROP TRIGGER IF EXISTS ${name} ON ${table}`,
    `CREATE CONSTRAINT TRIGGER ${name} AFTER ${event.toUpperCase()} ON ${table} DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${TRUST_GENERATION_FUNCTION}()`,
  ];
}

export const TRUST_GENERATION_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${TRUST_POLICY_STATE_TABLE} (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  generation BIGINT NOT NULL DEFAULT 0,
  bumped_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${TRUST_POLICY_STATE_TABLE} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$`,
  `INSERT INTO ${TRUST_POLICY_STATE_TABLE} (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  BUMP_FUNCTION,
  ...Object.entries(TRUST_GENERATION_WHEN).flatMap(([table, events]) =>
    (Object.entries(events) as [GenerationEvent, string][]).flatMap(([event, when]) => trustGenerationTriggerSql(table, event, when))),
];

export const TRUST_GENERATION_SCHEMA_SQL = `${TRUST_GENERATION_SCHEMA_STATEMENTS.join(';\n')};\n`;
