**`gbrain takes extract --from-pages --dry-run` sends nothing to the model unless you also pass `--yes`.**

<!-- behavior-change: takes_extract_dry_run_needs_yes_9547 -->

### Fixed
- `gbrain takes extract --from-pages --dry-run` without `--yes` lists and counts the candidate pages and calls no model, as its "preview" wording promised; it used to send every candidate page to the chat model without `--yes`. Its output says nothing was sent and no claims were classified, and `--json` carries `dry_run: true` with `claims_extracted: null`. `--dry-run --yes` keeps the old preview: it classifies the candidates and writes nothing (#9547, reported and first fixed by @Kkkkkuro).
