/**
 * The doctor reads of src/core/engine-sql/doctor-sources.ts keep the statement text doctor checks built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each variant's constant statements (and the roster members' text) equal, whitespace aside, the text the
 *    caller ran before the read moved (the adopted skill-pack read byte for byte), including the statements built from the guest, claim and connector-kind helpers.
 *  - Regression: a drifted constant (a typo, a lost archived filter, a connector kind missing) changes what doctor reads
 *    on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines, not the text against the old builders.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import { guestSourceSql } from '../src/core/guests/note.ts';
import { CONNECTOR_KINDS_SQL } from '../src/core/persistence/connector-kinds.ts';
import { TRUST_CLAIM_LIFTED_AT_KEY, claimedSourceSql, notConnectorSourceSql } from '../src/core/trust/claim-state.ts';
import {
  countDefaultSourceFiles, doctorSourceStatements, listAdoptedSkillPackSourceIds, listCheckoutRoots, listGuestSourceRows, listOwnedContentRows, listPendingRoster,
  type DoctorSourceVariant,
} from '../src/core/engine-sql/doctor-sources.ts';

/** Whitespace is not part of a statement: runs of it collapse and none sits inside a parenthesis. */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
const texts = (variant: DoctorSourceVariant, scope = {}): string[] => doctorSourceStatements(variant, scope).map(squash);

/** The statements a member without a variant table runs, recorded by an executeRaw that answers no rows. */
async function recorded(run: (raw: (sql: string, params?: unknown[]) => Promise<never[]>) => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  await run(async (sql) => { seen.push(squash(sql)); return []; });
  return seen;
}

const FRESH_COLUMNS = 'id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at, config';
const NO_UPSTREAM = 'NULL AS upstream_checked_at, NULL AS upstream_commit, NULL AS upstream_behind';

describe('doctor source reads SQL text', () => {
  test('statements that read the source roots keep their text', () => {
    expect(texts('roots_live_ordered')).toEqual(['SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL ORDER BY id COLLATE "C"']);
    expect(texts('roots_live_fallback')).toEqual([
      'SELECT id, local_path, config FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE',
      'SELECT id, local_path, config FROM sources WHERE local_path IS NOT NULL']);
    expect(texts('live_path_ids')).toEqual(['SELECT id FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL']);
    expect(texts('live_path_ids', { sourceIds: ['a'] })).toEqual(['SELECT id FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL AND id = ANY($1::text[])']);
    expect(texts('paths_scoped')).toEqual(['SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND ($1::text[] IS NULL OR id = ANY($1::text[])) ORDER BY id COLLATE "C"']);
    expect(texts('relative_paths')).toEqual(["SELECT id, local_path FROM sources WHERE id <> 'default' AND local_path IS NOT NULL AND local_path <> '' AND archived IS NOT TRUE ORDER BY id COLLATE \"C\""]);
    expect(texts('pathless_live')).toEqual(["SELECT id FROM sources WHERE (local_path IS NULL OR local_path = '') AND archived IS NOT TRUE ORDER BY id COLLATE \"C\""]);
    expect(texts('brain_writer_by_id', { sourceId: 'x' })).toEqual(["SELECT id, local_path, config->>'kind' AS kind FROM sources WHERE id = $1"]);
    expect(texts('brain_writer_live')).toEqual([
      "SELECT id, local_path, config->>'kind' AS kind FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id COLLATE \"C\"",
      "SELECT id, local_path, config->>'kind' AS kind FROM sources WHERE local_path IS NOT NULL ORDER BY id COLLATE \"C\""]);
  });

  test('statements that read a source flag keep their text', () => {
    expect(texts('config_shape')).toEqual(["SELECT id, jsonb_typeof(config) AS typ FROM sources WHERE jsonb_typeof(config) <> 'object'"]);
    expect(texts('strict_git')).toEqual(["SELECT id, local_path, last_commit FROM sources WHERE NOT archived AND COALESCE(config->>'canonical','')='git' ORDER BY id COLLATE \"C\""]);
    expect(texts('google_connectors')).toEqual(["SELECT id, incarnation::text AS incarnation, local_path, config FROM sources WHERE archived IS NOT TRUE AND config->>'kind' = 'google' ORDER BY id COLLATE \"C\""]);
    expect(texts('guest_marked_ids')).toEqual(["SELECT id FROM sources WHERE COALESCE(config->>'guest' = 'true', false) ORDER BY id COLLATE \"C\""]);
    expect(texts('first_two_ids')).toEqual(['SELECT id FROM sources ORDER BY id COLLATE "C" LIMIT 2']);
    expect(texts('all_ids')).toEqual(['SELECT id FROM sources ORDER BY id COLLATE "C"']);
    expect(texts('ids_with_live_pages')).toEqual([squash(`SELECT s.id FROM sources s WHERE EXISTS (
      SELECT 1 FROM pages p WHERE p.source_id = s.id AND p.deleted_at IS NULL ) ORDER BY s.id COLLATE "C"`)]);
    expect(texts('local_path_state')).toEqual(['SELECT id, local_path, archived FROM sources']);
    expect(texts('storage_shelf', { sourceId: 'x' })).toEqual(['SELECT local_path, config FROM sources WHERE id = $1 AND archived IS NOT TRUE']);
    expect(texts('shared_skills_view', { sourceId: 'x' })).toEqual(['SELECT config,incarnation FROM sources WHERE id=$1 AND NOT archived']);
    expect(texts('detached', { sourceId: 'x' })).toEqual(["SELECT local_path, config->>'strategy' AS strategy, last_commit FROM sources WHERE id=$1 AND archived IS NOT TRUE"]);
    expect(texts('synopsis_ids')).toEqual(["SELECT id FROM sources WHERE contextual_retrieval_mode = 'per_chunk_synopsis' AND NOT archived ORDER BY id COLLATE \"C\""]);
    expect(texts('live_incarnations')).toEqual(['SELECT id,incarnation::text AS incarnation,local_path,config FROM sources WHERE archived IS NOT TRUE']);
    // The multi_source_drift roster as src/commands/doctor/report-remote.ts built it at 3852ea1505, the trailing space included.
    expect(doctorSourceStatements('drift_roster')).toEqual(['SELECT id, local_path FROM sources ']);
    expect(doctorSourceStatements('drift_roster', { sourceIds: ['a'] })).toEqual(['SELECT id, local_path FROM sources WHERE id = ANY($1::text[])']);
  });

  test('the connector, claim and freshness statements equal what their builders produced', () => {
    expect(texts('connector_keys')).toEqual([`SELECT id,incarnation::text,local_path,config,archived FROM sources WHERE config->>'kind' IN (${CONNECTOR_KINDS_SQL})`]);
    expect(texts('claim_candidates')).toEqual([squash(
      `SELECT s.id, ${claimedSourceSql('s')} AS claimed, (s.config ? '${TRUST_CLAIM_LIFTED_AT_KEY}') AS lifted
       FROM sources s WHERE NOT s.archived AND ${notConnectorSourceSql('s')} ORDER BY s.id COLLATE "C"`)]);
    for (const scoped of [false, true]) {
      const scope = scoped ? ' AND id = ANY($1::text[])' : '';
      expect(texts('freshness', scoped ? { sourceIds: ['a'] } : {})).toEqual([
        `SELECT ${FRESH_COLUMNS}, upstream_checked_at, upstream_commit, upstream_behind FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE${scope}`,
        `SELECT ${FRESH_COLUMNS}, ${NO_UPSTREAM} FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE${scope}`,
        `SELECT ${FRESH_COLUMNS}, ${NO_UPSTREAM} FROM sources WHERE local_path IS NOT NULL${scope}`]);
    }
  });

  test('the roster members keep their text', async () => {
    expect(await recorded((raw) => listGuestSourceRows(raw))).toEqual([squash(
      `SELECT s.id, s.local_path, s.config, g.writers, g.trust_ceiling AS ceiling FROM sources s LEFT JOIN guest_sources g ON g.source_id = s.id WHERE ${guestSourceSql('s.config', 's.id')} ORDER BY s.id COLLATE "C"`)]);
    expect(await recorded((raw) => listCheckoutRoots(raw, null))).toEqual([squash(
      `SELECT DISTINCT local_path AS root,id AS source_id FROM sources WHERE local_path IS NOT NULL AND NOT COALESCE(archived,false)
       UNION SELECT DISTINCT h.local_path,NULL FROM persistence_host_bindings h WHERE h.host_id=$1::uuid`)]);
    expect(await recorded((raw) => listPendingRoster(raw, null, null))).toEqual([squash(
      `SELECT s.id, s.last_commit, s.config, (b.source_id IS NOT NULL) AS managed, COALESCE(h.local_path, s.local_path) AS root
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = b.worktree_id AND h.host_id::text = $2
      WHERE s.archived IS NOT TRUE AND (b.source_id IS NOT NULL OR s.local_path IS NOT NULL)
        AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id COLLATE "C"`)]);
    expect(await recorded((raw) => countDefaultSourceFiles(raw))).toEqual([squash(
      `SELECT COUNT(*)::int AS live, COUNT(*) FILTER (WHERE source_path IS NOT NULL)::int AS file_backed FROM pages WHERE source_id = 'default' AND deleted_at IS NULL`)]);
    const [owned] = await recorded((raw) => listOwnedContentRows(raw, null, false));
    expect(owned).toStartWith('SELECT s.id,s.incarnation,s.local_path,s.config,s.last_commit,p.brain_id,c.value AS receipt, h.local_path AS owner_root,b.relative_path,');
    expect(owned).toEndWith("AND NOT EXISTS (SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain')");
    expect(owned).toContain('JOIN persistence_brain p ON p.singleton=1 AND (p.enabled OR $2::boolean) JOIN config c ON c.key=\'shared_skills.content.v1.\'||s.id||\'.\'||s.incarnation::text');
  });

  test('the adopted skill-pack read sends the text src/core/shared-skills/adopted-packs.ts ran at 88cfad0f15, byte for byte', async () => {
    const seen: Array<{ sql: string; params: unknown }> = [];
    await listAdoptedSkillPackSourceIds(async (sql: string, params?: unknown[]) => { seen.push({ sql, params }); return [] as never[]; });
    expect(seen).toEqual([{ params: undefined, sql: `SELECT s.id FROM sources s
        WHERE s.id <> 'default' AND EXISTS (
          SELECT 1 FROM shared_skill_packs p
            JOIN shared_skill_heads h ON h.source_id = p.source_id AND h.source_incarnation = p.source_incarnation
                                     AND h.pack_id = p.pack_id AND NOT h.deleted
           WHERE p.source_id = s.id AND p.source_incarnation = s.incarnation)` }]);
  });
});
