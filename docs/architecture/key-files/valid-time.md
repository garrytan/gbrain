# Valid time (page editions by date)

GBRA-217. Guide: [page history](../../guides/page-history.md#valid-time). Recorded time (`known_as_of`) is the
[belief ledger](belief-ledger.md).

- `src/core/valid-time.ts` — the one date normaliser (`validDate` in TypeScript, `validDateSql` in SQL, the same
  pattern: `YYYY-MM-DD`, a YAML Date or a midnight-UTC timestamp; anything else is undated), the pure status rules
  (`validTimeVerdict`: status, history `retained|incomplete|unknown`, the one `why`), the plain-read status
  (`currentValidTime`), the write advisory (`validTimeWriteAdvisory`) and the client's version-skew check
  (`assertValidTimeEcho`, `host_upgrade_required`). Intervals are half-open, as links are.
- `src/core/ops/valid-time-read.ts` — `get_page {as_of}`. One REPEATABLE READ transaction: the page identity (a slug in
  two granted sources refuses), then one statement picks over the current page and its `page_versions` (greatest
  `valid_from` on or before the date, latest recorded on a tie) with the counts, gap facts and ambiguity window, before
  any visibility check; a chosen edition the caller may not see is `page_not_found`. Reasons use
  `replacedBecauseSql`, so their visibility matches `get_versions`. Only `in_force` returns text at the top level;
  other statuses nest the edition under `last_in_force` / `earliest_known`. Large or segmented editions are windowed;
  the gpw1 cursor pins `v:<version id>` or the current revision (found again among versions if the page moved on), and
  an edition that has gone answers `history: incomplete`, `why: edition_pruned`. Recovery fixes: `git log --follow`
  for a world-visible file in a source with a checkout, else `ask_user` for a backup (always on a repo-less brain).
- `src/core/persistence/valid-time-advisory.ts` — `withValidTimeAdvisory`, wrapped around `withChangeReason` in
  `service.ts` for page writes: compares the page before and after the apply and adds `valid_time` to the outcome
  (`valid_from_unparsed`, `valid_time_correction`, `valid_time_date_only`). Reads only rows the write's transaction
  produced; changes nothing.
- `src/cli/page-render.ts` valid-time helpers — `validTimeLine` (stderr header), `printAsOfWindows` (pages a windowed
  edition by its `next` calls), `asOfExitCode` (15 when no edition is in force). `src/cli/main.ts` calls
  `assertValidTimeEcho` on every thin-client as_of reply.

Pinned by `test/valid-time-gbra217.test.ts` (PGLite and Postgres).
