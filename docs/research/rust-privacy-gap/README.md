# Real Rust addon: which reads refuse `excludePrivate`, and for which caller

Measured 2026-11-23 at commit 86eb40c4c95f6d7c2b66550ba165d0ea7d8fb955 (local branch `vorflux/shadow-privacy-rerun`, a1 head 1d40b7a531 merged). Build: the real addon built from that tree, whose `rust/` is byte-identical to origin/rust-engine/shadow-follow c786e766da63670e578e1e36af5fa8e4471b7725
(`rust/target/addon/gbrain_engine.linux-x64-glibc.node`, no Rust changes in a1 or a2). Read-only investigation; nothing in
`src/core/rust-engine/` or `rust/` was changed.

## TL;DR

- 14 of the 20 mirrored read members refuse the option `excludePrivate` for EVERY caller, with no caller record at all
  (`engine_capability_missing`, "(option excludePrivate) yet", reason = the member's capability). That is the member table, not the policy text.
- 4 members serve `excludePrivate` only for ONE caller: the baseline, a read made outside any caller record. `searchKeyword`,
  `searchTitles` and `searchVector` refuse every read made inside a caller record, including an EMPTY one (`withCallerAccess({})`), an anonymous remote
  caller and an owner. `listFactsByEntity` serves any non-owner record (it opts in with `callerReaders`) and refuses an owner record.
- Cause of the 3 search members: `storePageTextPolicy` compares the rendered page fragment with `withoutCallerAccess(() => privatePagesFilterForCaller('p'))`.
  With no record the fragment carries `AND NOT EXISTS (SELECT 1 FROM access_pending_coverage pc ...)` (fail-closed pending coverage). Inside any record it
  carries the record's `folderCoverage` form instead (first difference at token 26 of 7,296 vs 7,046 characters), so the text is never the baseline's.
  Only `callerReaders` families (facts) have a second, canonical, record-bearing form to match; the page families do not.
- Who sends `excludePrivate`: `resolveExcludePrivatePages(engine, ctx.remote)` (private-visibility.ts:1343) is true for every REMOTE request (MCP over
  stdio or HTTP, `gbrain serve`) unless the operator relaxed privacy, and for local `--as <member>` reads; it is false for the plain local CLI. So a brain that is
  only used from the local CLI is not affected. A brain with `gbrain serve` traffic is: each such read becomes a `capability_missing` row, and
  `reads.capability_missing_7d > 0` fails criterion 2 (readiness.ts:171) for the next 7 days after the last one.
- a2 does not create the refusals for members refused by option (they fail identically on a1). What a2 changes: a1 ran Rust under NO record for a remote
  read, so Rust answered as an anonymous caller (a possibly wrong answer, a `diff`/`match` under the wrong policy). a2 runs Rust under the captured record, so the real
  engine now refuses where it cannot honour that record. That is the honest outcome, and it makes the gap visible.
- a2 bug found and fixed while doing this (commit 86eb40c4c9): a read made outside any caller record was captured as the default stand-in record, which
  made Rust refuse reads it serves today (the same text mismatch). The wrapper now captures the real record or none, and the child and the serving process run
  under none when there was none.

## Table: member x caller -> served / refused

Cell = `<read without excludePrivate> / <same read with excludePrivate: true>`. `R-option:<cap>` = refused because the option is not served at all
(any caller); `R-caller:<cap>` = served for the baseline caller, refused for this caller's policy text. `R-other` is not a privacy refusal.

| member | no caller record (local CLI) | local owner (`owner`, hidePrivate false) | remote, no member | remote, source grant only | remote owner | remote member | remote member + private grant |
|---|---|---|---|---|---|---|---|
| getPage | served / R-option:pages | same | same | same | same | same | same |
| listPages | served / R-option:pages | same | same | same | same | same | same |
| findPages (`untrusted.excludePrivate`) | served / R-option:pages | same | same | same | same | same | same |
| resolveSlugs | R-other:pages / R-option:pages | same | same | same | same | same | same |
| resolveSlugWithAlias | served / R-option:pages | same | same | same | same | same | same |
| getChunks | served / R-option:chunks | same | same | same | same | same | same |
| getLinks | served / R-option:links | same | same | same | same | same | same |
| getBacklinks | served / R-option:links | same | same | same | same | same | same |
| getTags | served / R-option:tags | same | same | same | same | same | same |
| getTimeline | served / R-option:timeline | same | same | same | same | same | same |
| searchKeywordChunks | served / R-option:keyword_search | same | same | same | same | same | same |
| countKeywordPages | served / R-option:keyword_search | same | same | same | same | same | same |
| searchTakes | served / R-option:takes | same | same | same | same | same | same |
| searchTakesVector | served / R-option:takes | same | same | same | same | same | same |
| **searchKeyword** | served / **served** | served / R-caller:keyword_search | served / R-caller:keyword_search | same | same | same | same |
| **searchTitles** | served / **served** | served / R-caller:keyword_search | same | same | same | same | same |
| **searchVector** | served / **served** | served / R-caller:vector_search | same | same | same | same | same |
| listFactsByEntity | served / served | served / R-caller:facts | served / served | served / served | served / R-caller:facts | served / served | served / served |
| getStats, findByTitleFuzzy | served (no such option) | served | served | served | served | served | served |

`resolveSlugs` plain read: refused for the name I used (`alice`, a partial: "a name with no exact page needs trigram matching"); an exact slug is served. Not a privacy matter.
Raw output (full messages): run the repro below without `--markdown`.

Caller records used (CallerAccess fields, all synthetic approximations of what dispatch builds with `remoteCallerAccess`; the result does not depend on them,
because `withCallerAccess({})` alone already refuses the three search members):
no caller = no `withCallerAccess`; local owner = `{owner:true, hidePrivate:false, restricted:false}`; remote, no member = `{hidePrivate:true, restricted:true, applyRemoteReadPolicy:true}`;
source grant = that plus `privateReadableSources:['default']`; remote owner = remote plus `identity:['member:owner-example'], owner:true, ownerReads:true`;
remote member = remote plus `identity:['member:alice-example']`; member + grant = member plus `privateReadableSources:['default']`.
Bisect (`searchKeyword` + `excludePrivate`, each record field alone over the default): every one of `{}`, hidePrivate, restricted, applyRemoteReadPolicy, owner, identity,
privateReadableSources, remotePolicy and ownerReads refuses.

## Minimal repro

```bash
cd <gbrain worktree>   # a build of the addon at rust/target/addon/ (bun run rust:build)
PATH=/var/tmp/bun144/bun-home/bin:$PATH bun /code/.plans/a-evidence/rust-privacy-gap.repro.ts --markdown
```

Five-line version (one member, one caller): in a script run from the repo root, open a fresh `openRustEngine({ addon, databasePath: dir })`, `connect`, then

```ts
await engine.searchKeyword('w', { excludePrivate: true });                              // served
await withCallerAccess({}, () => engine.searchKeyword('w', { excludePrivate: true }));  // engine_capability_missing, reason keyword_search
```

(`withCallerAccess` from `src/core/search/private-visibility.ts`.) The refusal text is raised by `storePageTextPolicy` in
`src/core/rust-engine/store-members/private-provenance.ts`: "excludePrivate for a caller whose member pages, grants or lineage widen the policy".

## What this means for swap readiness on the owner's brain

- If the owner's shadow only sees local CLI reads (no `gbrain serve` MCP/HTTP traffic, no `--as`): no `excludePrivate`, no refusals from this cause.
- If it serves remote clients with privacy not relaxed: every remote `search`/`query`/`get_page`/`list_pages`/`get_links`/`get_tags`/... read mirrors as
  `capability_missing` (14 members always, the 3 search members for any record), so criterion 2 cannot pass while such traffic continues. Criteria 6 and 4 can
  still pass: the privacy check never sees a Rust row for a refused read, and recall is scored on `searchVector` samples that Rust served (local, no record).
- Fix choices (not made here; the Rust lane owns them): (a) serve the options (14 members) and add a record-bearing canonical form for the page families
  (what `callerReaders` does for facts), or (b) have the lane owner rule that mirrored reads carrying `excludePrivate` under a record are `unmirrorable`
  (counted in usage, not compared): honest about coverage, but it means the swap is not verified for remote traffic. I recommend (a) for the 3 search
  members and `getPage`/`listPages` first, because those carry the remote traffic.

Verification limit: the table was produced on an empty Rust brain, because the refusal happens in the TypeScript adapter before the store is read.
It shows which reads are refused, not what the served reads return.
