# The brain store: page visibility guards

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A remote page write first learns whether its caller may see the page it names, which of a list of pages the
caller reads, what its visibility check opens with, and whether a stored writer carries a slug fence. PGLite and
Postgres ran these reads through `executeRaw` in `src/core/persistence/page-visibility.ts` (`remoteTargetHidden`,
`remotePageAccess`, `authorizePageVisibility` and `storedOwnerSpeaksForItself`). The SQL now lives in `src/core/engine-sql/page-visibility.ts`. The store answers
the two page reads from its page records (`crates/gbrain-store/src/page_visibility.rs`) and the fence from the
local writer registration it already keeps; it adds no keys.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageHiddenFromCaller(sourceId, slug, policy)` | `true` when the page row of the source (live or soft-deleted) fails `policy`; `false` for a missing page | `readPageHiddenFromCaller` |
| `brain.readWriteVisibilityProbe(sourceId, slug, policy)` | `{ any_labelled, identity_may_open, owner_only_source, owner_only_any }`. `any_labelled`: any access member, of any status, carries the labelled-only grant ([access-members.md](access-members.md)). `identity_may_open` is `null` when the page row (live or soft-deleted) is missing or passes `policy`, else whether it names readers (`readable_by`) or a folder rule covers it. `owner_only_source` and `owner_only_any`: the source, or any source, has `config ->> 'kind'` `imessage` or `config ->> 'owner_only'` `true` | `readWriteVisibilityProbe` |
| `brain.readCallerPageAccess(pages, policy)` | `[{ source_id, slug, readable }]`, one row per distinct `{ sourceId, slug }` of `pages` that names a page row, `readable` when the row is live and passes `policy`. Rows come in pair order; PGLite sets no order | `readCallerPageAccess` |
| `brain.listWhoCanReadPages(slug, sourceId, form)` | `[{ slug, source_id, type, frontmatter, folder_rule_ids, owner_only }]`, every page row named `slug` (live or soft-deleted), in `sourceId` only when given, by source id bytes; `owner_only` is whether the owner-only test holds in `form` (`fn` or `closed`; the TypeScript member reads `mode` as `fn`, since the store keeps no owner-only read mode); `folder_rule_ids` is the sorted `source:rule_id` of each rule that covers the page, `null` when none does | `listWhoCanReadPages` (`gbrain access who-can-read`) |

`policy` is the store `PrivacyPolicy` of `facts/privacy.rs` (`page_hidden`). With `entityPrivacy` false it is the
member-access part alone (the page's readers, and the origin of a derived page): the `access` part of the members.

## TypeScript members

`src/core/rust-engine/store-members/page-visibility.ts` answers the three BrainEngine members on a Rust brain.

- `readPageHiddenFromCaller` and `readCallerPageAccess` take `{ policy: 'read' | 'access' }`. The `read` part
  renders `privatePagesFilterForCaller('p')` and maps it through `storePageTextPolicy`, as the other page reads do.
  The `access` part renders `callerAccessAllowedSql('p')` in the current access record and serves it only when it
  equals the no-caller rendering or the rendering of a fresh record with only the caller's reader identity and
  private-readable grant. The capability is `pages`.
- `readWriteVisibilityProbe(sourceId, slug)` renders `readPolicyFragment('p', [], true)` (the empty identity with
  privacy, which equals the no-caller rendering) and maps it through `storePageTextPolicy`.
- A caller on a brain whose config holds no member-access restriction renders the short member-access form, anonymous
  or with a reader identity. The page members judge it under the restricted rendering instead (`judgeWidenedCaller`),
  and so does the probe for any unrestricted caller, since its identity is always empty. The restricted rendering only
  adds conditions, so it never shows a page the short form hides; it hides no more while no page carries
  `readable_by`, which the store's restriction flag (`access.restrictions_present`, set on the first such write, never
  cleared) guarantees whenever the config says unrestricted. A reader identity reaches the policy only through a
  page's readers, so the same holds for a member caller
  (`test/engine-parity/unrestricted-member-page-reads.test.ts`).
- `listWhoCanReadPages(slug, sourceId, form)` (`src/core/rust-engine/store-members/access-reports.ts`) passes
  `closed` through and reads `fn` and `mode` as `fn`: the store keeps no owner-only read mode, so `mode` never widens
  the test. The capability is `pages`.
- `readWriterSlugFence(principal)` reads a `local_cli` or `local_stdio` writer's stored grant ceiling
  (`brain.readLocalWriter`) and returns its `slugPrefixes`, or `null`. Another kind, other than an OAuth client,
  carries no fence and reads nothing. The capability is `persistence_journal`.

## Differences from PGLite

- **Owner-only sources.** A page policy for a caller that is not the owner ends with the owner-only test
  (`ownerOnlyAllowedSql`). The member reads which form the policy text carries and sends it as `ownerOnly`
  (`ownerOnlyFormIn`): `fn` when the text holds `ownerOnlyPageSql(alias, 'fn')`, `closed` when it holds
  `ANY_OWNER_ONLY_SQL`, `off` when it holds neither (the owner). The store applies the same form in `page_hidden`
  (`owner_only.rs`), so every read that goes through `page_hidden` applies it, not only these three. `closed`: while
  any source is owner-only, every page is hidden. `fn`: a page is hidden when its source is owner-only, or when it is
  a concept or question with a `concept-provenance` / `synthesized_from` link to a page in an owner-only source. The
  store keeps no `derivation_inputs` (PGLite writes them only through raw SQL, which a Rust brain refuses), so the
  function's walk over them finds nothing on either side. `ownerOnly` is always one of the three names: a policy
  with no `ownerOnly` is `closed`, and any other value (`null` too) is refused before the store reads
  (`tests/owner_only_form_contract.rs`).

- **Callers the store does not render.** A caller whose access record adds an audience or a lineage renders a
  policy the store cannot judge, and so does a labelled-only caller's remote floor. Both page members then refuse
  with `engine_capability_missing` before any read. Satisfied folder rules (row 32b-1) and the labelled-only grant
  (row 32e: a page passes only when its readers name the caller or it carries a rule the caller satisfies) are
  served ([facts.md](facts.md)).
- **OAuth clients.** The store keeps no OAuth clients, so `readWriterSlugFence` for an `oauth_client` principal
  refuses with `engine_capability_missing`.
- **Writer ids.** PGLite casts the writer id to `uuid` and fails on an id that is not one. The store looks the
  id up as given (lowercased) and returns `null` when no writer has it.
