# Planner statistics on PGLite

PGLite (the embedded engine) has no autovacuum, so nothing collects planner
statistics on its own. Without them the query planner guesses row counts and
runs search and graph reads as nested loops over every page: a search that
takes 40 ms on an analyzed 10,000-page brain can take tens of seconds on an
unanalyzed one. GBrain keeps these statistics fresh for you. This is on by
default; Postgres brains are unaffected (autovacuum owns statistics there).

## How it works

- Every statement that changes `pages`, `links`, `facts`, `takes`,
  `content_chunks` or `timeline_entries` records how many rows it touched in
  `planner_stats_deltas`. The record commits or rolls back with the data and
  survives crashes and restarts, so changes from remote `put_page`,
  `remember`, raw SQL or a killed process all count.
- A table is stale when the rows changed since its last ANALYZE exceed
  `max(500, 10% of the table)`, or when it has rows but no statistics.
- Stale tables are analyzed (`ANALYZE <table>`, bounded by sample size, not
  table size) at these points:
  - the first search, `get_health`, orphan, backlink, graph or page-list read
    (at most one check every 2 seconds per process);
  - every `import.analyze_every_pages` files (default 500) during
    `gbrain import` and managed sync;
  - before a stale link drain of at least 500 pages (`gbrain extract --stale`,
    the dream cycle's extract phase, link extraction after a managed sync) and
    every `import.analyze_every_pages` pages during it; `link_transitions` and
    `link_relationships` are analyzed whenever `links` is;
  - after the dream cycle's freshness phases, and when the resident write
    consumer is idle;
  - the full ANALYZE that import and sync already run at the end resets every
    table's pending count.
- If a table's last ANALYZE took longer than `planner.first_read_budget_ms`
  (default 2000), a read does not wait for it: the table is analyzed right after
  the read answers.

## Check and repair

```bash
gbrain doctor                          # planner_stats_stale names each stale table
gbrain repair planner-stats            # preview: stale tables and pending row counts
gbrain repair planner-stats --apply    # ANALYZE them now (works with auto-analyze off)
```

On Postgres, `planner_stats_stale` reads `pg_stat_user_tables` and warns only
when a table is over the same threshold and neither ANALYZE nor autoanalyze ran
in the last hour; the repair runs each ANALYZE with a 60 s statement and 2 s
lock timeout.

Postgres can also lose the statistics outright: `pg_upgrade` carries none and
resets the modification counters, so autovacuum never collects them again
until 10% of a table changes. Without the page columns search filters read,
search plans as nested loops over every page (50-60 s per search at 5,000
pages instead of 0.5 s). gbrain guards this two ways, both through the same
refresh as import and sync (`ANALYZE pages(...)` and
`ANALYZE content_chunks(model, modality, page_id)`, 30 s bounded):

- The first search of each process checks in the background and collects them
  when the database role owns the tables. The search does not wait for it.
- `planner_stats_stale` warns with the absent columns, and
  `gbrain repair planner-stats --apply` collects them (run it as the table
  owner when the brain's role is not).

## Settings and opt-out

| Setting | Default | Effect |
|---|---|---|
| `planner.auto_analyze` (env `GBRAIN_PLANNER_AUTO_ANALYZE`, which wins) | `true` | `false` turns off every automatic ANALYZE, including the full ANALYZE at the end of import and sync (which falls back to the narrow `pages` refresh the search projection needs). Doctor still reports stale tables. |
| `planner.first_read_budget_ms` | `2000` | A stale table whose last ANALYZE took longer is analyzed after the read instead of before it. |
| `import.analyze_every_pages` | `500` | Import, managed sync and stale link drains check statistics every N files or pages; `0` disables that cadence. |

To opt out: `gbrain config set planner.auto_analyze false`. To turn it back on:
`gbrain config set planner.auto_analyze true`.
