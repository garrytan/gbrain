-- 0003_confer_world_consensus_view.sql
-- Per spec §6.4 (audit finding B4 - reuse upstream calibration_profiles +
-- sources.config, no parallel infra).
--
-- Note: upstream calibration_profiles stores per-domain Brier inside the
-- `domain_scorecards` JSONB column, NOT as a `domain` text column. This
-- view uses the overall `brier` for v0.1.0; per-domain extraction (via
-- `(cp.domain_scorecards->>tp.domain)::float`) lands in v0.2.0 once we
-- have eval evidence that per-domain weighting changes the consensus rank.
--
-- The view is the source of truth. take_proposals.world_consensus column
-- (added in 0002) is a nightly cache refreshed by a minion job.

CREATE OR REPLACE VIEW confer_world_consensus AS
SELECT
  tp.id AS take_proposal_id,
  COUNT(DISTINCT agree.holder)
    FILTER (WHERE agree.status = 'accepted') AS holder_agreement_count,
  AVG(cp.brier)
    FILTER (WHERE agree.status = 'accepted') AS avg_holder_brier,
  MAX((s.config->>'tier_weight')::float) AS max_source_tier,
  LEAST(1.0,
    (COUNT(DISTINCT agree.holder)
       FILTER (WHERE agree.status = 'accepted'))::float / 3.0
    * COALESCE(MAX((s.config->>'tier_weight')::float), 0.5)
    * (1.0 - COALESCE(AVG(cp.brier)
       FILTER (WHERE agree.status = 'accepted'), 0.5))
  ) AS world_consensus
FROM take_proposals tp
LEFT JOIN take_proposals agree
  ON agree.claim_text = tp.claim_text
  AND agree.id != tp.id
LEFT JOIN calibration_profiles cp
  ON cp.holder = agree.holder
  AND cp.source_id = agree.source_id
LEFT JOIN sources s
  ON s.id = tp.source_id
GROUP BY tp.id;

COMMENT ON VIEW confer_world_consensus IS
  'Confer fork extension. Derived consensus signal. Nightly minion job refreshes take_proposals.world_consensus column from this view. Spec section 6.4.';
