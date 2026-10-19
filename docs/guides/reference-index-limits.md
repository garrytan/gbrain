# Reference index limits

Link reconciliation and database-free company inspection use the same
source-local index of slugs, titles and aliases. By default it refuses a source
above 100,000 pages or 16 MiB of encoded reference metadata with
`request_too_large`. Both checks are inclusive: a value exactly at the limit
is allowed. Names, ambiguity handling and source isolation keep the same rules
when the limits increase.

**Say to your agent:** *"Use `gbrain config set` to raise the reference index
limits on my brain host after checking its memory budget."*

The host can set either limit independently:

```bash
gbrain config set links.reference_index_max_pages 600000
gbrain config set links.reference_index_max_bytes 67108864
```

These are host file settings, shared by every local brain using that host
configuration. They also work during inspection without a database. Set them
on the host that runs extraction or inspection; a remote client's configuration
does not change the server. New index builds read the settings, so an existing
index keeps its captured limits until the next build.

`GBRAIN_LINKS_REFERENCE_INDEX_MAX_PAGES` and
`GBRAIN_LINKS_REFERENCE_INDEX_MAX_BYTES` override their corresponding file
settings. Values must be positive safe integers (at most 9,007,199,254,740,991);
zero does not disable a check. `config set` refuses invalid values before
writing, including with `--force`. Invalid runtime overrides refuse the build.
Remove an environment override before unsetting a file setting to restore the
default:

```bash
gbrain config unset links.reference_index_max_pages
gbrain config unset links.reference_index_max_bytes
```

The byte count is the UTF-8 encoding of `[slug, title, normalizedAliases]` for
each page, including JSON punctuation. It measures input metadata rather than
heap size. Raising it permits more strings, maps and sets in memory and a
longer synchronous build. Metadata for other sources and other process state
also need room: the unscoped `loadLinkPageMetadata` already loads metadata
across all sources before building a source-local index. Neither limit is a
process-wide memory cap.

## Synthetic measurements

Run each size in a fresh process; no database or providers are used:

```bash
nice -n 10 bun --no-env-file scripts/bench-reference-index.ts 100000
nice -n 10 bun --no-env-file scripts/bench-reference-index.ts 300000
nice -n 10 bun --no-env-file scripts/bench-reference-index.ts 600000
```

Measured on Linux x86-64, runtime 1.4.3, a shared host with 16 logical CPUs and
61 GiB RAM. Three fresh processes per size generated sequential slugs, titles
and two unique aliases per page. Limits were raised to the generated count
and byte total. Build time excludes imports and metadata generation. Peak RSS
is the largest whole-process high-water mark across the three runs, including
imports, generated metadata and the index. CPU contention was substantial;
the range records it rather than predicting production latency.

| Pages | Metadata | Median build | Build range | Peak RSS |
| ---: | ---: | ---: | ---: | ---: |
| 100,000 | 7.72 MiB | 1.65 s | 1.55–1.97 s | 524 MiB |
| 300,000 | 23.17 MiB | 5.52 s | 4.75–5.69 s | 1,666 MiB |
| 600,000 | 46.35 MiB | 22.70 s | 9.78–69.41 s | 3,014 MiB |

Budget headroom beyond these numbers for the real corpus, concurrent work,
database drivers and all-source metadata. Longer names or more aliases can
increase memory further. Raising only the page limit may still hit the byte
limit. These measurements cover index construction, not extraction throughput
or search latency.

Company inspection additionally bounds its committed inventory to 100,000
entries and 16 MiB of plan metadata, with a 5,000,000-byte file limit. Those
independent admission bounds still apply; raising the reference index settings
does not permit a larger company import.
