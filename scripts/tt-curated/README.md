# tt-curated

Lightweight operator notes for TT's curated gbrain pipeline.

## Purpose
This directory maintains a narrowed, high-signal slice of the Obsidian vault for nightly retrieval quality checks.

## Source of truth
- Runtime config: `config.yaml`
- Bootstrap template: `config.example.yaml`
- Query cases: `query-cases.yaml`
- Shared shell env loader: `config_loader.py`

## First-time setup
```bash
cp config.example.yaml config.yaml
# then edit config.yaml for your local paths / chat target
```

If `config.yaml` is missing or malformed, the loader now fails with a direct bootstrap hint that tells you to rebuild from `config.example.yaml`.

## Main commands
```bash
./gbrain-curated status
./gbrain-curated dashboard
./gbrain-curated cleanup 20
./gbrain-curated smoke
./gbrain-curated regression
./gbrain-curated refresh
./gbrain-curated refresh-replay /abs/path/to/manifest.json
./gbrain-curated nightly
./gbrain-curated baseline
./gbrain-curated weekly
```

## What config.yaml controls
- core paths (vault, stage, db, logs, scripts)
- Telegram failure alert target
- embed dimensions (`768`)
- embed retry policy
- stage include paths/files
- cron/nightly alert policy
- artifact filenames
- query case file path

## Expected behavior
- silent on success
- Telegram alert only on failure
- curated PGLite stays at `768` dimensions
- smoke/regression use the shared YAML case file

## Ops observability / control plane
### Dashboard artifacts
`./gbrain-curated dashboard` writes:
- `CURATED_LOG_DIR/control-plane/refresh-dashboard.md`
- `CURATED_LOG_DIR/control-plane/refresh-status.md`

They summarize:
- recent failures
- replay/chunk history
- auto-escalation state
- current smoke/regression status

### Auto-escalation threshold
Dashboard artifacts default to threshold `1` recent failure.
If recent failures meet or exceed the threshold, the dashboard marks:
- `Auto-escalation: ON`

### Cron-safe cleanup / retention
Use conservative cleanup for old manifests only:
```bash
./gbrain-curated cleanup 20
```

Policy:
- keep newest `20` manifest files
- do not delete current log snapshots
- safe to run from cron because it only removes older manifest JSONs in the fallback cleanup root

## Verification
```bash
python3 -m py_compile config_loader.py query-regression.py refresh-smoke-check.py weekly-baseline-review.py refresh_manifest_consumer.py
bash -ic './refresh-smoke-check.py'
bash -ic './query-regression.py'
bash -ic './gbrain-curated status'
bash -ic './gbrain-curated dashboard'
```
