# The brain store: page visibility guards

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A remote page write first learns whether its caller may see the page it names, which of a list of pages the
caller reads, and whether a stored writer carries a slug fence. PGLite and Postgres ran these reads through
`executeRaw` in `src/core/persistence/page-visibility.ts` (`remoteTargetHidden`, `remotePageAccess` and
`storedOwnerSpeaksForItself`). The SQL now lives in `src/core/engine-sql/page-visibility.ts`. The store answers
the two page reads from its page records (`crates/gbrain-store/src/page_visibility.rs`) and the fence from the
local writer registration it already keeps; it adds no keys.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageHiddenFromCaller(sourceId, slug, policy)` | `true` when the page row of the source (live or soft-deleted) fails `policy`; `false` for a missing page | `readPageHiddenFromCaller` |
| `brain.readCallerPageAccess(pages, policy)` | `[{ source_id, slug, readable }]`, one row per distinct `{ sourceId, slug }` of `pages` that names a page row, `readable` when the row is live and passes `policy`. Rows come in pair order; PGLite sets no order | `readCallerPageAccess` |

`policy` is the store `PrivacyPolicy` of `facts/privacy.rs` (`page_hidden`). With `entityPrivacy` false it is the
member-access part alone (the page's readers, and the origin of a derived page): the `access` part of the members.

## TypeScript members

`src/core/rust-engine/store-members/page-visibility.ts` answers the three BrainEngine members on a Rust brain.

- `readPageHiddenFromCaller` and `readCallerPageAccess` take `{ policy: 'read' | 'access' }`. The `read` part
  renders `privatePagesFilterForCaller('p')` and maps it through `storePageTextPolicy`, as the other page reads do.
  The `access` part renders `callerAccessAllowedSql('p')` in the current access record and serves it only when it
  equals the no-caller rendering or the rendering of a fresh record with only the caller's reader identity and
  private-readable grant. The capability is `pages`.
- `readWriterSlugFence(principal)` reads a `local_cli` or `local_stdio` writer's stored grant ceiling
  (`brain.readLocalWriter`) and returns its `slugPrefixes`, or `null`. Another kind, other than an OAuth client,
  carries no fence and reads nothing. The capability is `persistence_journal`.

## Differences from PGLite

- **Callers the store does not render.** A caller whose access record adds folder rules, an audience, a lineage
  or a labelled-only grant renders a policy the store cannot judge. Both page members then refuse with
  `engine_capability_missing` before any read.
- **OAuth clients.** The store keeps no OAuth clients, so `readWriterSlugFence` for an `oauth_client` principal
  refuses with `engine_capability_missing`.
- **Writer ids.** PGLite casts the writer id to `uuid` and fails on an id that is not one. The store looks the
  id up as given (lowercased) and returns `null` when no writer has it.
