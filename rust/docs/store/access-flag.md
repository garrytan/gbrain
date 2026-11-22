# The brain store: the member-access flag

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`src/core/search/private-visibility.ts` applies the member-access filter only on a brain whose config
`access.restrictions_present` is `'1'`. PGLite and Postgres set that flag from two triggers that schema migration v282
creates: `pages_access_mark_restricted` (after a page row is inserted, or its frontmatter is updated, and the new
frontmatter has a top-level `readable_by` key) and `access_members_mark_restricted` (after an access member is added),
and from two that v283 creates: `access_rules_mark_restricted` and `access_pending_coverage_mark_restricted` (after a
folder rule or a pending prefix is added). Nothing clears the flag.

The store sets the flag in four places (`crates/gbrain-store/src/access_flag.rs`), so no page record with
`readable_by` sits in the store while the flag is unset:

- the page write hook: `pages::write_page` calls `access_flag::mark_restricted` in the same write as the page record;
- every store write handle: `Store::write` hands its closure an `access_flag::FlaggingWriter`, which sets the flag
  on the put of a page record (key family `P`) whose frontmatter has a top-level `readable_by` key, and on the put
  of a folder rule or a pending prefix (`z 0x02`, `z 0x03`; [access_rules.md](access_rules.md)), whatever code
  path made the put. A value that does not decode counts as naming readers, since the flag only makes reads
  stricter. `pages::write_page` is the only such path today; the handle holds the rule for any later one;
- the open-time scan: the first open of a brain with no scan record (meta `access_flag_scan`) reads every page
  record, soft-deleted ones too, and sets the flag if one names readers, then writes the record in the same write.
  v282 sets the flag the same way once when it runs. A brain created by this build writes the record when it is
  created. The scan runs once, so a flag an operator unsets by hand stays unset, as on Postgres.
- the access member insert: `access_members::insert_access_member` sets the flag in the same write as the member
  record ([access-members.md](access-members.md)), as the `access_members_mark_restricted` trigger does.

When the scan cannot write (a full disk, or a record file that took the open but refuses the write), the open does
not fail. The store reads the snapshot instead, and when a page record names readers, or that read does not finish,
the process reads the flag as `'1'` (`Store::flag_assumed`) through `getConfig`, `getConfigValues`, `getAllConfig`
and `listConfigKeys`, and through every store read (`AssumedFlagRead`), so the short member-access form of a privacy
policy (`open`, `facts/privacy.rs` `readers_allowed`) still walks the origins and hides restricted pages. Nothing is stored; the next open that can write runs the scan.
The scan never runs in two other cases:

- a second handle or process that opens a brain another one holds: the record file lock refuses that open with
  `store_locked` before the scan (`gbrain-store` `redb_kv.rs`), and a second gbrain process becomes a client of
  the owner process (`src/core/rust-engine/owner-ipc/election.ts`), whose open ran the scan;
- a record file the process may not write: the open fails with `store_io` (permission denied) before the scan, as
  it did before the scan existed, since the record store opens its file for writing.

It adds no JS method: the flag is read through `getConfig`. The key is the config key `access.restrictions_present`.

| Trigger | Store |
| --- | --- |
| `pages_access_mark_restricted` | sets the flag on every write of a page record whose frontmatter has a top-level `readable_by` key, when the flag is not already `'1'` |
| v282 backfill (`INSERT ... WHERE EXISTS`) | the open-time scan, once per brain |
| `access_rules_mark_restricted`, `access_pending_coverage_mark_restricted` | sets the flag on every put of a folder rule or pending prefix record |
| `access_members_mark_restricted` | sets the flag in the same write as every member insert (`access_members::insert_access_member`, [access-members.md](access-members.md)), when the flag is not already `'1'` |

The trigger fires only when an UPDATE names the frontmatter column; the store sets the flag on any write of such a
page. The flag is sticky, so the two differ only after an operator unsets the flag by hand.

## Tests

- `crates/gbrain-store/tests/access_flag.rs`: a nested `readable_by` leaves the flag unset; a top-level one sets it,
  and it stays set after the key is dropped and the page soft-deleted; another value is set to `'1'`. The open-time
  scan sets the flag on a brain whose reader page (live or soft-deleted) has no flag, leaves it unset when no page
  names readers, and runs once, so a flag unset by hand stays unset. An open whose scan cannot write (a record
  access that refuses every write) opens, reads the flag as `'1'` when a page names readers, leaves it unset when
  none does, and stores nothing.
- `crates/gbrain-store/src/access_flag.rs` (unit tests): a raw put of a page record that names readers sets the flag,
  on its own write and inside a transaction at commit; a rolled-back one leaves it unset.
- `test/engine-parity/access-flag.test.ts`: the same sequence on every arm, read through `getConfig`.
