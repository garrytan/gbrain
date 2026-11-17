---
kind: action
---
`gbrain takes extract --from-pages --dry-run` without `--yes` no longer sends page content to the chat model. It lists the candidate pages and counts them, reports no claim count (`claims_extracted` is null and `dry_run` is true in `--json`), and writes nothing. A script that relied on a dry run classifying claims without `--yes` now needs `--dry-run --yes`, which classifies the candidates and still writes nothing.
