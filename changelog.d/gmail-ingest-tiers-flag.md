**You can turn Gmail ingest tiers on or off when you add a Google source.**

### Added
- Pass `--ingest-tiers` or `--no-ingest-tiers` to `gbrain sources add --kind google`. Defaults are unchanged. This addresses the missing `g_ingest_tiers` CLI flag noted in #10032.
