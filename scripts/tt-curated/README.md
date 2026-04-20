# tt-curated

Lightweight operator notes for TT's curated gbrain pipeline.

## Purpose
This directory maintains a narrowed, high-signal slice of the Obsidian vault for nightly retrieval quality checks.

## Source of truth
- Pipeline config: `config.yaml`
- Query cases: `query-cases.yaml`
- Shared shell env loader: `config_loader.py`

## Main commands
```bash
./gbrain-curated status
./gbrain-curated smoke
./gbrain-curated regression
./gbrain-curated refresh
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

## Verification
```bash
python3 -m py_compile config_loader.py query-regression.py refresh-smoke-check.py weekly-baseline-review.py
bash -ic './refresh-smoke-check.py'
bash -ic './query-regression.py'
bash -ic './gbrain-curated status'
```
