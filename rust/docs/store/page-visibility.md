# The brain store: page visibility guards

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A remote page write first learns whether its caller may see the page it names, which of a list of pages the
caller reads, what its visibility check opens with, and whether a stored writer carries a slug fence. PGLite and
Postgres ran these reads through `executeRaw` in `src/core/persistence/page-visibility.ts` (`remoteTargetHidden`,
`remotePageAccess`, `authorizePageVisibility` and `storedOwnerSpeaksForItself`). The SQL now lives in `src/core/engine-sql/page-visibility.ts`. The store answers
the page reads from its page records (`crates/gbrain-store/src/page_visibility.rs`) and the fence from the
local writer registration it already keeps; it adds no keys.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageHiddenFromCaller(sourceId, slug, policy)` | `true` when the page row of the source (live or soft-deleted) fails `policy`; `false` for a missing page | `readPageHiddenFromCaller` |
| `brain.readWriteVisibilityProbe(sourceId, slug, policy)` | `{ any_labelled, identity_may_open, owner_only_source, owner_only_any }`. `any_labelled` is whether any `access_members` row holds the labelled-only grant (`EXISTS (SELECT 1 FROM access_members WHERE labelled_only)`): a disabled or removed member still counts, and the owner is not excluded here (the later writer check excludes it). `identity_may_open` is `null` when the page row (live or soft-deleted) is missing or passes `policy`, else whether it names readers (`readable_by`) or a folder rule of its source is stamped on it. `owner_only_source` is whether this source has `config ->> 'kind'` `imessage` or `config ->> 'owner_only'` `true`. `owner_only_any` is whether any source is owner-only or any owner-only mark was ever set (once one is, it stays on) | `readWriteVisibilityProbe` |
| `brain.readPagePrivacyHidden(sourceId, slug, honorAliases)` | `true` when the live page fails the privacy part alone (`privacyPartSql`: its own fields, derived origin and declared lineage, judged by `privacy_allows`), `false` when it passes, `null` when it has no live row (missing or soft-deleted). `honorAliases` is whether the privacy aliases count, as the rendered fragment says | `readPagePrivacyHidden` |
| `brain.readCallerPageAccess(pages, policy)` | `[{ source_id, slug, readable }]`, one row per distinct `{ sourceId, slug }` of `pages` that names a page row, `readable` when the row is live and passes `policy`. Rows come in pair order; PGLite sets no order | `readCallerPageAccess` |

`policy` is the store `PrivacyPolicy` of `facts/privacy.rs` (`page_hidden`). With `entityPrivacy` false it is the
member-access part alone (the page's readers, and the origin of a derived page): the `access` part of the members.

## TypeScript members

`src/core/rust-engine/store-members/page-visibility.ts` answers the BrainEngine members on a Rust brain.

- `readPageHiddenFromCaller` and `readCallerPageAccess` take `{ policy: 'read' | 'access' }`. The `read` part
  renders `privatePagesFilterForCaller('p')` and maps it through `storePageTextPolicy`, as the other page reads do.
  The `access` part renders `callerAccessAllowedSql('p')` in the current access record and serves it only when it
  equals the no-caller rendering or the rendering of a fresh record with only the caller's reader identity and
  private-readable grant. The capability is `pages`.
- `readWriteVisibilityProbe(sourceId, slug)` renders `readPolicyFragment('p', [], true)` (the empty identity with
  privacy, which equals the no-caller rendering) and maps it through `storePageTextPolicy`.
- `readPagePrivacyHidden(sourceId, slug)` passes `honorAliases` as `pagePolicyFlags(privacyPartSql('p')).honorAliases`, so it
  equals what the SQL renders. The owner's own page write (`ownerRewriteOf`) reads it to keep a private page private. The
  capability is `pages`.
- A caller on a brain whose config holds no member-access restriction renders the short member-access form, anonymous
  or with a reader identity. The page members judge it under the restricted rendering instead (`judgeWidenedCaller`),
  and so does the probe for any unrestricted caller, since its identity is always empty. The restricted rendering only
  adds conditions, so it never shows a page the short form hides; it hides no more while no page carries
  `readable_by`, which the store's restriction flag (`access.restrictions_present`, set on the first such write, never
  cleared) guarantees whenever the config says unrestricted. A reader identity reaches the policy only through a
  page's readers, so the same holds for a member caller
  (`test/engine-parity/unrestricted-member-page-reads.test.ts`).
- `readWriterSlugFence(principal)` reads a `local_cli` or `local_stdio` writer's stored grant ceiling
  (`brain.readLocalWriter`) and returns its `slugPrefixes`, or `null`. For an `oauth_client` it reads the stored
  client record (`brain.readOauthClient`) and returns its `bound_slug_prefixes` (its `delegated_slug_prefixes` for a
  delegated write), or `null` when the client is gone. Another kind carries no fence and reads nothing. The
  capability is `persistence_journal`.

## Differences from PGLite

- **A page with no live row.** When the earlier checks in `authorizePageVisibility` have not already decided a remote
  write, the check judges a page that has only a soft-deleted row (or no row) with a raw statement, and a Rust brain
  refuses that statement with `engine_capability_missing`. A page with a live row is judged through the typed reads.
- **Owner-only sources.** A page policy for a caller that is not the owner ends with the owner-only test
  (`ownerOnlyAllowedSql`). The member reads which form the policy text carries and sends it as `ownerOnly`
  (`ownerOnlyFormIn`): `fn` when the text holds `ownerOnlyPageSql(alias, 'fn')`, `closed` when it holds
  `ANY_OWNER_ONLY_SQL`, `off` when it holds neither (the owner). The store applies the same form in `page_hidden`
  (`owner_only.rs`), so every read that goes through `page_hidden` applies it, not only these three. `closed`: while
  any source is owner-only, every page is hidden. `fn`: a page is hidden when its source is owner-only, or when it is
  a concept or question with a `concept-provenance` / `synthesized_from` link to a page in an owner-only source, or when
  its recorded inputs (`derivation_inputs`, transitively) reach a marked row or a row held in an owner-only source, as
  the function's walk does ([facts.md, "Derivation inputs"](facts.md#derivation-inputs-generationsderivation_inputsrs)).
  `ownerOnly` is always one of the three forms: master's
  member names the `fn` form `lineage`, which the store reads as `fn`; a policy with no `ownerOnly` is `closed`, and
  any other value (`null` too) is refused before the store reads
  (`tests/owner_only_form_contract.rs`).

- **Callers the store does not render.** A caller whose access record adds folder rules, an audience, a lineage
  or a labelled-only grant renders a policy the store cannot judge. Both page members then refuse with
  `engine_capability_missing` before any read. A remote write's writer is the exception: `readLinkTargetPages` serves
  the writer's one identity with the folder rules it satisfies and the labelled-only grant
  ([remote-links.md](remote-links.md)), so a labelled-only member's rewrite of a page it is not named on ends on
  `page_not_found`, as on PGLite and Postgres.
- **OAuth clients.** For an `oauth_client` principal, `readWriterSlugFence` reads the stored client's
  `bound_slug_prefixes` (its `delegated_slug_prefixes` for a delegated write), or returns `null` when the client is gone.
- **Writer ids.** PGLite casts the writer id to `uuid` and fails on an id that is not one. The store looks the
  id up as given (lowercased) and returns `null` when no writer has it.
