## Summary
- add manifest-driven refresh execution helpers and control-plane artifact generation
- add `gbrain-curated` dashboard / cleanup / refresh-replay commands
- preserve explicit `CURATED_LOG_DIR` / `CURATED_STAGE` env overrides over config defaults
- document control-plane notes, auto-escalation threshold, and cron-safe cleanup policy

## What changed
### Control plane / observability
- add `refresh_manifest_consumer.py`
  - build refresh plans from manifest input
  - write include files for chunked changed-note refreshes
  - execute staged refresh/import/smoke/status flow
  - append refresh run history to JSONL
  - build dashboard/status notes from recent run history
  - compute auto-escalation from recent failures
  - garbage-collect old fallback manifest files conservatively

### CLI
- extend `gbrain-curated` with:
  - `dashboard`
  - `cleanup [keep]`
  - `refresh [manifest.json]`
  - `refresh-replay <manifest.json>`
- keep explicit `CURATED_LOG_DIR` / `CURATED_STAGE` env values when `config_loader.py shell` is evaluated

### Stage behavior
- update `refresh-stage.sh` to support manifest include-file mode via `CURATED_MANIFEST_INCLUDE_FILE`
- preserve default full-stage behavior when no manifest include file is present

### Docs
- document dashboard outputs:
  - `CURATED_LOG_DIR/control-plane/refresh-dashboard.md`
  - `CURATED_LOG_DIR/control-plane/refresh-status.md`
- document default auto-escalation threshold (`1` recent failure)
- document cron-safe cleanup / retention policy and new commands

## Why
PR17 adds an operator-facing control plane on the curated side so refresh runs are observable and manageable without digging through raw logs:
- dashboard/status notes for quick inspection
- recent failure summary and replay/chunk history index
- explicit auto-escalation behavior
- conservative cleanup suitable for cron

## Verification
- [x] `pytest -q test_refresh_manifest_consumer.py test_gbrain_curated_cli.py -q`
- [x] `bash -n gbrain-curated`
- [x] `python3 -m py_compile refresh_manifest_consumer.py`
- [x] `pytest -q`

## Notes for reviewers
- one behavior fix here is env precedence in `gbrain-curated`: explicit caller-provided `CURATED_LOG_DIR` / `CURATED_STAGE` now win over config defaults
- README threshold text was aligned to implementation/tests: auto-escalation defaults to `1` recent failure
