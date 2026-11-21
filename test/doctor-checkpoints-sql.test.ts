/**
 * The statements of src/core/engine-sql/doctor-checkpoints.ts keep the exact text the doctor readers built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the three statements that spliced a constant (`TOMBSTONE`, `LIVE_TOMBSTONE`, `identityDowngradeOpen('p')`)
 *    equal the text those readers composed before the constant was inlined, the credential re-chunk hold read equals
 *    the text readCredentialResealHolds composed with its chunker generation bound as $1, and no member lists a name
 *    the engine lacks.
 *  - Regression: a drifted inlined predicate changes which parks and downgrade records doctor reports on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines on an empty brain, not the text against the old builder.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import {
  DOCTOR_CHECKPOINT_MEMBERS, LIST_DERIVED_ORIGIN_PARKS_SQL, LIST_OPEN_IDENTITY_DOWNGRADES_SQL, LIST_PURGE_PARKS_SQL,
} from '../src/core/engine-sql/doctor-checkpoints.ts';
import { TOMBSTONE } from '../src/core/persistence/derived-origin-hold.ts';
import { LIVE_TOMBSTONE } from '../src/core/persistence/purge-parks.ts';
import { identityDowngradeOpen } from '../src/core/sync-identity-downgrades.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { LIST_CREDENTIAL_RESEAL_HOLD_ROWS_SQL } from '../src/core/engine-sql/doctor-checkpoints.ts';
import {
  CREDENTIAL_RESEAL_HOLD_OP, CREDENTIAL_RESEAL_HOLD_PAGES, CREDENTIAL_RESEAL_LIVE_HOLD, CREDENTIAL_RESEAL_PRODUCER,
} from '../src/core/page-state/credential-reseal.ts';

describe('doctor checkpoint SQL text', () => {
  test('derived-origin parks: the statement readDerivedOriginParks composed', () => {
    expect(LIST_DERIVED_ORIGIN_PARKS_SQL).toBe(
      `SELECT o.completed_keys->0 AS park FROM op_checkpoints o WHERE o.op=$1 AND ${TOMBSTONE} ORDER BY o.updated_at, o.fingerprint COLLATE "C"`);
  });

  test('purge parks: the statement readPurgeParks composed', () => {
    expect(LIST_PURGE_PARKS_SQL).toBe(
      `SELECT o.fingerprint, o.completed_keys->0 AS park FROM op_checkpoints o WHERE o.op=$1 AND ${LIVE_TOMBSTONE} ORDER BY o.fingerprint COLLATE "C"`);
  });

  test('identity downgrades: the statement listIdentityDowngrades composed', () => {
    expect(LIST_OPEN_IDENTITY_DOWNGRADES_SQL).toBe(
      `SELECT dg.completed_keys->0 AS record, np.slugs AS new_slugs FROM op_checkpoints dg JOIN pages p ON p.id::text = dg.fingerprint
      LEFT JOIN LATERAL (SELECT array_agg(slug ORDER BY slug COLLATE "C") AS slugs FROM pages WHERE source_id = p.source_id AND deleted_at IS NULL AND source_path = dg.completed_keys->0->>'to') np ON true
      WHERE dg.op = $1 AND p.deleted_at IS NOT NULL AND ${identityDowngradeOpen('p')}
        AND p.source_id = dg.completed_keys->0->>'source_id' AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      ORDER BY dg.completed_keys->0->>'recorded_at' COLLATE "C", dg.fingerprint COLLATE "C"`);
  });

  test('credential re-chunk holds: the statement readCredentialResealHolds composed, with the producer bound as $1', () => {
    const composed = `SELECT h.completed_keys->0 AS hold, p.body_storage IS NOT DISTINCT FROM 'segmented' AS segmented
    FROM ${CREDENTIAL_RESEAL_HOLD_PAGES} WHERE h.op='${CREDENTIAL_RESEAL_HOLD_OP}' AND ${CREDENTIAL_RESEAL_LIVE_HOLD} AND ($2::text[] IS NULL OR p.source_id=ANY($2::text[])) ORDER BY p.id`;
    expect(LIST_CREDENTIAL_RESEAL_HOLD_ROWS_SQL).toBe(composed.replace(`= '${CREDENTIAL_RESEAL_PRODUCER}'`, '= $1'));
    expect(LIST_CREDENTIAL_RESEAL_HOLD_ROWS_SQL).not.toContain(CREDENTIAL_RESEAL_PRODUCER);
  });

  test('every listed member is a classified engine member, once', () => {
    expect(new Set(DOCTOR_CHECKPOINT_MEMBERS).size).toBe(DOCTOR_CHECKPOINT_MEMBERS.length);
    for (const member of DOCTOR_CHECKPOINT_MEMBERS) expect(Object.keys(RUST_ENGINE_MEMBERS)).toContain(member);
  });
});
