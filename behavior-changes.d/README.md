# behavior-changes.d

One file per behavior change that gbrain's one-time upgrade notice discloses
(`behavior_changes`, src/core/behavior-change-notice.ts). A PR adds its
rows here instead of editing the table, so two PRs never touch the same
line and nobody picks a version before the release.

## Add a row

1. Write the notice text, one paragraph of plain text (at most 2,000
   characters, no markup), in `behavior-changes.d/<id>.md`. The id is
   lowercase letters, digits and `_`, starting with a letter, unique across the table, for example
   `sync_holds_unparsable_8123`.
2. Name the id in your PR's changelog fragment (`changelog.d/<slug>.md`)
   on its own line:

   ```markdown
   <!-- behavior-change: sync_holds_unparsable_8123 -->
   ```

3. Start the file with front matter that says what kind of change it is:

   ```markdown
   ---
   kind: fix
   ---
   The notice text.
   ```

   `kind` is one of `breaking` (something documented stops working or
   starts refusing what it accepted), `action` (users should do something),
   `default` (a default changed), `fix` or `add`. A `breaking` row also
   needs `exception: security` or `exception: data-loss` for a fix that
   cannot wait, or `deprecation: <id>` naming the
   [deprecations.d](../deprecations.d/) record whose `remove_after` date has
   passed. The front matter is not part of the notice text.

That is all. `bun run check:public-surface` refuses a new row without
`kind`, and a `breaking` row without an exception or a matured deprecation.
It also refuses a change to the CLI or agent-contract goldens
(`test/fixtures/goldens/cli/`, `test/fixtures/agent-contract/`) that adds no
row; when the change is not a behaviour change, say so in your changelog
fragment with `<!-- public-surface: no-behavior-change: <reason> -->`.
`bun run verify` (check:regen-all) refuses a fragment with no
marker, a marker with no fragment, a duplicate id (including an id marked
twice among unreleased changes, or marked again after its release) and an
over-long text.

## What the release does

The release (`gstack-release-stamp open`) writes the new VERSION, runs
`bun scripts/build-behavior-changes.ts`, then folds every changelog fragment
into one CHANGELOG section under that version. While VERSION is newer than
the CHANGELOG's top release, the builder dates the pending markers with it,
in the order the fold writes them (fragments by path, then `## [Unreleased]`),
so its output equals what it generates once the markers sit under the new
heading. It writes src/core/behavior-changes.generated.ts: every fragment
whose marker is released, with that release as its `since`. The files here are never edited or deleted, so the release changes
only version stamps, the CHANGELOG and that generated file, which gstack's
land check regenerates byte for byte.

Until a release folds its marker, a fragment is pending: it generates
nothing, the notice does not show it, and the generated file does not change
on a PR.

## A row whose text is a function

Rows that compute their text (for example from the brain's config) stay in
the `BEHAVIOR_CHANGES` table, dated by their marker:

```ts
{ since: releasedIn('chat_chain_disclosure_8123'), id: 'chat_chain_disclosure_8123', text: (chain, remote) => ... },
```

with the same `<!-- behavior-change: <id> -->` line in the changelog
fragment. `releasedIn` reads the release from the generated file and is
`'TBD'` until then, which the notice never shows. A literal
`since: 'TBD'` row is refused (scripts/check-behavior-since.ts).
