**Owners can opt out of pruning saved versions during inline holding-page fact appends.**

### Added
- `versions.holding_prune_enabled` defaults to on, retaining the existing policy: a fact append to an inline holding page keeps its newest five saved versions and removes at most 100 older versions per save. Only the explicit value `false` disables that pruning.
- Before future saves, run `gbrain config set versions.holding_prune_enabled false` to disable this holding-specific pruning step for versions still present. This applies to `memory/unattributed` and folder holding pages. It does not recover already-pruned versions or clear existing history-gap markers, and saved-version storage can continue growing.
- Run `gbrain config set versions.holding_prune_enabled true` to restore the existing policy for subsequent fact appends. Those saves can then remove older saved versions in the normal batches. Fact rows remain on the holding page. Large inline-page and segmented-page retention policies are unchanged and can still prune a holding page that qualifies for those policies.

<!-- behavior-change: holding_version_prune_opt_out -->
