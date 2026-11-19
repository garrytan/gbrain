/**
 * The effect-journal statements in src/core/engine-sql/persistence-effects.ts are written out in full, so the engines
 * do not load the persistence modules (their imports reach most of the codebase). Each one copies text the effect
 * journal builds from shared fragments.
 *
 * 1. Protects: the effect claim, the queue insert, the release, the completions and the re-arm probe the engines run
 *    are the statements the effect journal's fragments describe (the dead-owner test, the refresh fence, the edge
 *    whitespace trim, the protocol predicate, the re-arm predicate and the two constants).
 * 2. Fails when: someone changes one of those fragments (for example the dead-owner key or the refresh-fence states)
 *    and the engines keep running the old text, so the claim disagrees with claimCoalescedGitEffects and the rest.
 * 3. Existing coverage: the effect tests check behavior on today's text; none compares the written-out copy with the
 *    fragments, and a changed fragment can keep those tests green.
 * 4. Production seam: none.
 */
import { describe, expect, test } from 'bun:test';
import {
  CLAIM_EFFECT_SQL, COMPLETE_EFFECT_SQL, COMPLETE_EFFECTS_SQL, HAS_REARMABLE_EFFECTS_SQL, QUEUE_EFFECTS_SQL,
  RELEASE_ABANDONED_EFFECT_CLAIMS_SQL, REMOTE_AUTO_LINKS_CONFIG_KEY, SELECT_CLAIMABLE_EFFECT_SQL, WITHHELD_BY_MIRROR_CODE,
} from '../src/core/engine-sql/persistence-effects.ts';
import { DEAD_OWNER_EFFECT_SQL, REARMABLE } from '../src/core/persistence/effect-journal.ts';
import { REMOTE_AUTO_LINKS_KEY, WITHHELD_BY_MIRROR } from '../src/core/persistence/effect-model.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from '../src/core/persistence/protocol.ts';
import { refreshFenceClear } from '../src/core/persistence/worktree-refresh-schema.ts';
import { asciiLowerSql, edgeTrimSql } from '../src/core/edge-whitespace.ts';

const completion = (alias: string, where: string) => `state=CASE WHEN jsonb_array_length(COALESCE(${alias}data->'parked','[]'::jsonb))>0 THEN 'failed' ELSE 'committed' END,
${where}error_code=CASE WHEN jsonb_array_length(COALESCE(${alias}data->'parked','[]'::jsonb))>0 THEN 'targets_parked' END,
${where}data=${alias}data-'retry_slugs'-'target_failures'-'failing_target'-'busy_retries'-'busy_since'-'busy_at',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,`;

describe('written-out effect-journal statements', () => {
  test('the claim select uses the dead-owner test and the refresh fence', () => {
    expect(SELECT_CLAIMABLE_EFFECT_SQL).toBe(`SELECT e.* FROM persistence_effects e
      LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
      WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now() OR ${DEAD_OWNER_EFFECT_SQL('e', '$2')}) AND e.next_attempt_at<=now()
      AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND (e.worktree_id IS NULL OR ${refreshFenceClear('e')})
      AND e.recovery IS NULL AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')))
      ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`);
    expect(CLAIM_EFFECT_SQL).toContain("claim_expires_at=now()+interval '2 minutes',attempts=attempts+1");
  });

  test('the queue insert gates mention links with the shared edge trim and the remote key', () => {
    expect(QUEUE_EFFECTS_SQL).toBe(`INSERT INTO persistence_effects (request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
    SELECT $1::uuid,t.e->>'kind',$2::uuid,t.e->'data',$3,$4::uuid,$5::uuid FROM jsonb_array_elements($6::text::jsonb) WITH ORDINALITY AS t(e,n)
    WHERE NOT (COALESCE((t.e->>'gated')::boolean,false) AND EXISTS (SELECT 1 FROM config
      WHERE key IN ('auto_link',$7) AND ${asciiLowerSql(edgeTrimSql('value'))} IN ('false','0','no','off')))
    ORDER BY t.n ON CONFLICT(request_id,kind) DO NOTHING RETURNING kind`);
    expect(REMOTE_AUTO_LINKS_CONFIG_KEY).toBe(REMOTE_AUTO_LINKS_KEY);
  });

  test('the writes declare the persistence protocol in the statement', () => {
    expect(RELEASE_ABANDONED_EFFECT_CLAIMS_SQL).toBe(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
    next_attempt_at=LEAST(next_attempt_at,now()) WHERE state='running' AND recovery IS NULL AND updated_at<$1::timestamptz
    AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`);
    expect(COMPLETE_EFFECT_SQL).toBe(`UPDATE persistence_effects SET
    ${completion('', '    ')}
    outcome=$3::text::jsonb,updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`);
    expect(COMPLETE_EFFECTS_SQL).toBe(`UPDATE persistence_effects e SET
        ${completion('e.', '        ')}
        outcome=$2::text::jsonb,updated_at=now()
        FROM jsonb_to_recordset($1::text::jsonb) AS t(id bigint,token uuid)
        WHERE e.id=t.id AND e.execution_token=t.token AND e.recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING e.id`);
  });

  test('the re-arm probe is the re-arm predicate with the withheld code', () => {
    expect(HAS_REARMABLE_EFFECTS_SQL).toBe(`SELECT 1 FROM persistence_effects e WHERE ${REARMABLE} LIMIT 1`);
    expect(WITHHELD_BY_MIRROR_CODE).toBe(WITHHELD_BY_MIRROR);
  });
});
