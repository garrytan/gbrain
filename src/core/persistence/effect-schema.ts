/** Independent postcommit work and forward-only withdrawal mirror recovery. */
export const PERSISTENCE_EFFECT_SCHEMA_SQL = `
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS source_incarnation uuid;
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS worktree_id uuid REFERENCES persistence_worktrees(id);
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS outcome jsonb;
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS recovery jsonb;
ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS recovery_bytes bigint NOT NULL DEFAULT 0 CHECK (recovery_bytes>=0);
INSERT INTO persistence_effects(request_id,kind,revision,data)
  SELECT DISTINCT ON (request_id) request_id,'withdrawal-mirror',revision,
    jsonb_build_object('source_id',data->>'source_id')
  FROM persistence_effects WHERE kind LIKE 'withdrawal-mirror:%'
  ORDER BY request_id,id ON CONFLICT(request_id,kind) DO NOTHING;
DELETE FROM persistence_effects WHERE kind LIKE 'withdrawal-mirror:%';
UPDATE persistence_effects e SET source_id=r.source_id,source_incarnation=r.source_incarnation,
  worktree_id=COALESCE(e.worktree_id,r.worktree_id,b.worktree_id)
  FROM persistence_requests r LEFT JOIN persistence_source_bindings b
    ON b.source_id=r.source_id AND b.source_incarnation=r.source_incarnation
  WHERE r.id=e.request_id AND e.source_incarnation IS NULL;
UPDATE persistence_effects SET data=data||'{"source_scan":true}'::jsonb WHERE kind='withdrawal-mirror';
INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
  SELECT e.request_id,k.kind,'{"source_scan":true}'::jsonb,e.source_id,e.source_incarnation,e.worktree_id
  FROM persistence_effects e CROSS JOIN (VALUES ('git'),('embedding')) AS k(kind)
  WHERE e.kind='withdrawal-mirror' ON CONFLICT(request_id,kind) DO NOTHING;
CREATE INDEX IF NOT EXISTS persistence_effects_pending ON persistence_effects(next_attempt_at,id)
  WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS persistence_effects_recovery ON persistence_effects(worktree_id)
  WHERE recovery IS NOT NULL;
`;
