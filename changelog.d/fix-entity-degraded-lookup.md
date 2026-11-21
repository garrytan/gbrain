**`entity` no longer says "No entity found" when its page lookup failed; it is marked degraded instead.**

### Fixed
- When the database read that finds an entity's page fails (a timeout, a permission error), `gbrain entity` and the MCP `entity` tool (one name or `names`) used to answer `found: false` with exit 0 and nothing marking it partial, so an agent could tell the user a person is not in their brain. The answer now carries the degraded stage `entity_lookup_failed` (reason `timeout` or `provider_error`): `_meta.degraded` and a `[gbrain degraded: entity_lookup_failed]` block over MCP, a `degraded` key with `--json`, and the same line on stderr in text mode. The exit code stays 0, and `GBRAIN_FAIL_ON_EMPTY=1` no longer reports such a call as "nothing matched". The same holds for a name-variant candidate's retirement and redirect-target reads, and under `GBRAIN_ENFORCED_MEMBER`. A brain without the `page_aliases` table yet is unchanged, and an engine that refuses raw reads still ends on its typed `engine_capability_missing` refusal.
- Normal entity output is unchanged byte for byte.

<!-- behavior-change: entity_lookup_failed_degraded_contract01 -->
