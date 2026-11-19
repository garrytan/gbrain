# The brain store: the large-page write guard

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A remote `put_page` measures the stored body of the page it replaces before the write is queued: above the inline
read size the replacement must name the revision it read and may not be much smaller than the stored body
(`src/core/persistence/large-page-guard.ts`). PGLite and Postgres ran that read through `executeRaw` in the guard.
The SQL now lives in `src/core/engine-sql/large-page.ts`. The store answers it from its page records and the body
state the page_body family keeps (`crates/gbrain-store/src/large_page.rs`); it adds no keys.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readStoredBodyBytes(slug, sourceId)` | the stored body size of the live page: a segmented page's `body_bytes` (both body columns NULL), else the UTF-8 bytes of `compiled_truth` plus `timeline` (an absent timeline counts 0); `null` for a missing or soft-deleted page, or a segmented page with no stored size | `readStoredBodyBytes` |

## TypeScript member

`src/core/rust-engine/store-members/large-page.ts` answers `readStoredBodyBytes` on a Rust brain. The member has
no caller policy: the guard reads the size of the page the write names, after the visibility guards ran. The
capability is `pages`.

## Tests

- `crates/gbrain-store/tests/large_page.rs`: inline sizes in UTF-8 bytes, and no size for a missing or soft-deleted page.
- `test/engine-parity/large-page.test.ts`: inline, segmented, shell, soft-deleted and missing pages on every arm.
- `test/large-page-sql-pin.test.ts`: the Postgres statement is the one the guard wrote by hand.
