# The brain store: the member-access flag

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`src/core/search/private-visibility.ts` applies the member-access filter only on a brain whose config
`access.restrictions_present` is `'1'`. PGLite and Postgres set that flag from two triggers that schema migration v282
creates: `pages_access_mark_restricted` (after a page row is inserted, or its frontmatter is updated, and the new
frontmatter has a top-level `readable_by` key) and `access_members_mark_restricted` (after an access member is added).
Nothing clears the flag.

The store sets the flag in the page write hook (`pages::write_page` calls `access_flag::mark_restricted`,
`crates/gbrain-store/src/access_flag.rs`), in the same write as the page record. It adds no JS method: the flag is
read through `getConfig`. The key is the config key `access.restrictions_present`.

| Trigger | Store |
| --- | --- |
| `pages_access_mark_restricted` | sets the flag on every write of a page record whose frontmatter has a top-level `readable_by` key, when the flag is not already `'1'` |
| `access_members_mark_restricted` | none: the store keeps no access members, so `gbrain access member add` cannot add one on a Rust brain |

The trigger fires only when an UPDATE names the frontmatter column; the store sets the flag on any write of such a
page. The flag is sticky, so the two differ only after an operator unsets the flag by hand.

## Tests

- `crates/gbrain-store/tests/access_flag.rs`: a nested `readable_by` leaves the flag unset; a top-level one sets it,
  and it stays set after the key is dropped and the page soft-deleted; another value is set to `'1'`.
- `test/engine-parity/access-flag.test.ts`: the same sequence on every arm, read through `getConfig`.
