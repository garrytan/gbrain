# Source cycle freshness state

Per-source maintenance freshness is stored in `source_cycle_state`, keyed by
`(source_id, source_incarnation)`. Runtime cycles write only this table; they do
not patch `sources.config`, whose bytes may participate in connector request
identity and receipts. Existing config timestamps remain intact and are used as
legacy fallback only when the current incarnation has no state row. Migration
170 creates the isolated table without parsing or migrating legacy config values.

## Upgrade and rollback

Before applying the schema migration on a multi-process installation, quiesce
old `gbrain autopilot`, `gbrain dream`, and other cycle writers, then upgrade
all writers together. Old binaries still write freshness timestamps into
`sources.config`; leaving one active can reintroduce config changes and
checkpoint-identity drift. The migration only creates the state table; it does not
parse legacy config or write provider state, grants, or projections.

A binary rollback does not remove or copy state back into config. Older readers
ignore `source_cycle_state` and see only the preserved legacy config timestamps;
cycles completed only after upgrade are therefore invisible to those readers.
The new reader prefers the state row whenever it exists, including a row with
NULL timestamps, and falls back to legacy config only when no row exists. If
rolling back, treat freshness as unavailable for cycles completed on the newer
binary, stop old writers before returning to the new binary, and run a fresh
cycle after upgrading again. Connector checkpoint identities and receipts are
not migrated, aliased, or rekeyed.
