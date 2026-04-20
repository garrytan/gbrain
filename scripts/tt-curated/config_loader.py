#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / 'config.yaml'


def load_config() -> dict:
    return yaml.safe_load(CONFIG_PATH.read_text())


def _get(cfg: dict, *keys: str):
    cur = cfg
    for key in keys:
        cur = cur[key]
    return cur


def paths(cfg: dict) -> dict:
    base = cfg['paths']
    curated_db_dir = Path(base['curated_db_dir'])
    curated_log_dir = Path(base['curated_log_dir'])
    script_dir = Path(base['script_dir'])
    return {
        'SCRIPT_DIR': str(script_dir),
        'HOME': base['sandbox_home'],
        'GBRAIN_ROOT': base['gbrain_root'],
        'GBRAIN_BUN_BIN_DIR': base['bun_bin_dir'],
        'GBRAIN_CLI': f"{base['bun_bin_dir']}/bun run src/cli.ts",
        'VAULT_ROOT': base['vault_root'],
        'CURATED_STAGE': base['curated_stage'],
        'CURATED_DB_DIR': str(curated_db_dir),
        'CURATED_DB_PATH': str(curated_db_dir / 'brain.pglite'),
        'CURATED_LOG_DIR': str(curated_log_dir),
        'OPENCLAW_CONFIG': base['openclaw_config'],
        'TELEGRAM_CHAT_ID': str(cfg['telegram']['chat_id']),
        'GBRAIN_EMBED_DIMENSIONS': str(cfg['env']['gbrain_embed_dimensions']),
        'EMBED_SAFE_ATTEMPTS': str(_get(cfg, 'pipeline', 'embed_safe', 'attempts')),
        'EMBED_SAFE_SLEEP_SECONDS': str(_get(cfg, 'pipeline', 'embed_safe', 'sleep_seconds')),
        'CRON_REFRESH_LOG_TAIL_LINES': str(_get(cfg, 'pipeline', 'cron', 'refresh', 'log_tail_lines')),
        'CRON_REFRESH_FAILED_CASE_LIMIT': str(_get(cfg, 'pipeline', 'cron', 'refresh', 'failed_case_limit')),
        'CRON_REFRESH_ALERT_PREFIX': str(_get(cfg, 'pipeline', 'cron', 'refresh', 'alert_prefix')),
        'CRON_NIGHTLY_LOG_TAIL_LINES': str(_get(cfg, 'pipeline', 'cron', 'nightly', 'log_tail_lines')),
        'CRON_NIGHTLY_FAILED_CASE_LIMIT': str(_get(cfg, 'pipeline', 'cron', 'nightly', 'failed_case_limit')),
        'CRON_NIGHTLY_SEVERE_DRIFT_CASE_LIMIT': str(_get(cfg, 'pipeline', 'cron', 'nightly', 'severe_drift_case_limit')),
        'CRON_NIGHTLY_ALERT_PREFIX': str(_get(cfg, 'pipeline', 'cron', 'nightly', 'alert_prefix')),
        'CRON_NIGHTLY_REGRESSION_ALERT_PREFIX': str(_get(cfg, 'pipeline', 'cron', 'nightly', 'regression_alert_prefix')),
        'SMOKE_LAST_JSON': str(curated_log_dir / cfg['artifacts']['smoke_last_json']),
        'REGRESSION_LAST_JSON': str(curated_log_dir / cfg['artifacts']['regression_last_json']),
        'REGRESSION_BASELINE_JSON': str(curated_log_dir / cfg['artifacts']['regression_baseline_json']),
        'WEEKLY_REVIEW_JSON': str(curated_log_dir / cfg['artifacts']['weekly_review_json']),
        'QUERY_CASES_PATH': cfg['query_cases']['path'],
        'COMMON_PATH': str(script_dir / 'common.sh'),
    }


def shell_exports(cfg: dict) -> str:
    env = paths(cfg)
    lines = []
    path_prefix = env['GBRAIN_BUN_BIN_DIR']
    current_path = os.environ.get('PATH', '')
    merged_path = f"{path_prefix}:{current_path}" if current_path else path_prefix
    env['PATH'] = merged_path
    include_paths = _get(cfg, 'pipeline', 'stage', 'include_paths')
    include_files = _get(cfg, 'pipeline', 'stage', 'include_files')
    env['CURATED_INCLUDE_PATHS_JSON'] = json.dumps(include_paths, ensure_ascii=False)
    env['CURATED_INCLUDE_FILES_JSON'] = json.dumps(include_files, ensure_ascii=False)
    for key, value in env.items():
        lines.append(f"export {key}={shlex.quote(value)}")
    return '\n'.join(lines)


def main() -> int:
    cfg = load_config()
    mode = sys.argv[1] if len(sys.argv) > 1 else 'json'
    if mode == 'json':
        print(json.dumps(cfg, indent=2, ensure_ascii=False))
        return 0
    if mode == 'paths':
        print(json.dumps(paths(cfg), indent=2, ensure_ascii=False))
        return 0
    if mode == 'shell':
        print(shell_exports(cfg))
        return 0
    raise SystemExit(f'unknown mode: {mode}')


if __name__ == '__main__':
    raise SystemExit(main())
