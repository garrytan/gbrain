---
kind: fix
---
When the database read that finds an entity's page fails, `entity` (one name or `names`) now returns the degraded marker in place of "No entity found" / found:false with nothing marking it partial. The answer carries the degraded stage entity_lookup_failed (MCP `_meta.degraded` and a `[gbrain degraded: ...]` block, the CLI `degraded` key under --json or a stderr line), so a failed lookup is never read as "this entity does not exist". The exit code stays 0. A healthy lookup, hit or miss, is unchanged byte for byte.
