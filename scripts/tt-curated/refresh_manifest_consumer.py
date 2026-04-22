from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _load_manifest(manifest_path: Path) -> dict[str, Any]:
    data = json.loads(manifest_path.read_text())
    if not isinstance(data, dict):
        raise ValueError('manifest must be a JSON object')
    return data


def summarize_stderr(stderr: str, *, max_lines: int = 3) -> str:
    lines = [line.strip() for line in (stderr or '').splitlines() if line.strip()]
    return ' | '.join(lines[:max_lines])


def _step_failure_category(step: str, ok: bool) -> str | None:
    if ok:
        return None
    return f'{step}_error'


def gc_old_manifests(manifest_root: str | Path, *, keep: int = 20) -> dict[str, Any]:
    root = Path(manifest_root)
    root.mkdir(parents=True, exist_ok=True)
    files = sorted(root.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    to_remove = files[max(0, keep):]
    removed: list[str] = []
    for path in to_remove:
        removed.append(path.name)
        path.unlink(missing_ok=True)
    return {'root': str(root.resolve()), 'removed_count': len(removed), 'removed': removed, 'kept_count': min(len(files), keep)}


def build_refresh_plan(
    *,
    manifest_path: str | Path,
    curated_stage: str | Path,
    curated_log_dir: str | Path,
    chunk_size: int = 50,
) -> dict[str, Any]:
    manifest_file = Path(manifest_path).resolve()
    manifest = _load_manifest(manifest_file)
    anchor_path = str(Path(manifest['anchor_path']).resolve())
    changed = [str(Path(p).resolve()) for p in manifest.get('changed_note_paths', [])]
    unique_changed: list[str] = []
    for path in changed:
        if path not in unique_changed:
            unique_changed.append(path)

    stage_root = Path(curated_stage).resolve()
    log_root = Path(curated_log_dir).resolve()
    stage_root.mkdir(parents=True, exist_ok=True)
    log_root.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')
    chunk_size = max(1, int(chunk_size))
    chunks = [unique_changed[i:i + chunk_size] for i in range(0, len(unique_changed), chunk_size)] or [[]]
    include_files: list[str] = []
    for idx, chunk in enumerate(chunks, start=1):
        include_file = stage_root / f'refresh-include-{ts}-part{idx}.txt'
        include_file.write_text('\n'.join([anchor_path, *chunk]) + '\n')
        include_files.append(str(include_file))

    log_path = log_root / 'refresh-run-log.jsonl'
    return {
        'manifest_path': str(manifest_file),
        'anchor_path': anchor_path,
        'changed_note_paths': unique_changed,
        'changed_count': len(unique_changed),
        'include_file': include_files[0],
        'include_files': include_files,
        'chunk_count': len(include_files),
        'chunk_size': chunk_size,
        'policy': manifest.get('policy', 'daily-summary-anchor'),
        'stage_root': str(stage_root),
        'log_root': str(log_root),
        'log_path': str(log_path),
        'refresh_stage_command': 'refresh-stage.sh',
        'import_extract_command': 'import-extract.sh',
        'smoke_command': 'refresh-smoke-check.sh',
        'status_command': 'gbrain-curated status',
    }


def write_refresh_run_log(log_path: str | Path, record: dict[str, Any]) -> str:
    path = Path(log_path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + '\n')
    return str(path)


def _run_shell(command: str, *, env: dict[str, str], cwd: str | None = None) -> dict[str, Any]:
    proc = subprocess.run(command, shell=True, capture_output=True, text=True, cwd=cwd, env=env)
    stderr = proc.stderr.strip()
    return {
        'ok': proc.returncode == 0,
        'exit_code': proc.returncode,
        'stdout': proc.stdout.strip(),
        'stderr': stderr,
        'stderr_summary': summarize_stderr(stderr),
        'command': command,
    }


def _status_json(log_dir: Path) -> dict[str, Any]:
    smoke_path = log_dir / 'refresh-smoke-last.json'
    reg_path = log_dir / 'query-regression-last.json'
    weekly_path = log_dir / 'weekly-baseline-review.json'

    def load(path: Path) -> dict[str, Any] | None:
        if not path.exists():
            return None
        return json.loads(path.read_text())

    smoke = load(smoke_path) or {}
    regression = load(reg_path) or {}
    weekly = load(weekly_path) or {}
    return {
        'smoke_ok': smoke.get('ok'),
        'smoke_passed': smoke.get('passed'),
        'smoke_total': smoke.get('total'),
        'regression_ok': regression.get('ok'),
        'regression_passed': regression.get('passed'),
        'regression_total': regression.get('total'),
        'weekly': weekly,
    }


def _load_jsonl(path: Path, *, limit: int | None = None) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    lines = [line for line in path.read_text().splitlines() if line.strip()]
    if limit is not None:
        lines = lines[-limit:]
    rows: list[dict[str, Any]] = []
    for line in lines:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def build_control_plane_artifacts(
    *,
    log_dir: str | Path,
    output_dir: str | Path,
    failure_threshold: int = 1,
    recent_limit: int = 10,
) -> dict[str, Any]:
    logs_root = Path(log_dir).resolve()
    out_root = Path(output_dir).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    refresh_rows = _load_jsonl(logs_root / 'refresh-run-log.jsonl', limit=recent_limit)
    status = _status_json(logs_root)
    failures = [row for row in refresh_rows if row.get('ok') is False]
    history = list(reversed(refresh_rows[-recent_limit:]))
    auto_escalation = len(failures) >= max(1, int(failure_threshold))

    dashboard_lines = [
        '# Refresh Dashboard',
        '',
        f'- Total recent runs: {len(refresh_rows)}',
        f'- Recent failures: {len(failures)}',
        f"- Auto-escalation: {'ON' if auto_escalation else 'OFF'} (threshold={failure_threshold})",
        '',
        '## Recent Failures',
    ]
    if failures:
        for row in reversed(failures):
            dashboard_lines.append(
                f"- {row.get('failure_category') or 'unknown'} | replay={row.get('replay', False)} | {row.get('stderr_summary', '')}".rstrip()
            )
    else:
        dashboard_lines.append('- none')

    dashboard_lines.extend(['', '## Replay / Chunk History'])
    if history:
        for row in history:
            dashboard_lines.append(
                f"- manifest={row.get('manifest_path', '')} | replay={row.get('replay', False)} | chunk_count={row.get('chunk_count', len(row.get('include_files', [])) or 1)} | ok={row.get('ok')}"
            )
    else:
        dashboard_lines.append('- none')

    status_lines = [
        '# Refresh Status',
        '',
        f"- smoke: {'ok' if status.get('smoke_ok') else 'fail'} ({status.get('smoke_passed')}/{status.get('smoke_total')})",
        f"- regression: {'ok' if status.get('regression_ok') else 'fail'} ({status.get('regression_passed')}/{status.get('regression_total')})",
        f"- weekly snapshot: {status.get('weekly', {}).get('generated_at', 'missing')}",
        f"- auto-escalation: {'ON' if auto_escalation else 'OFF'}",
    ]

    dashboard_note = out_root / 'refresh-dashboard.md'
    status_note = out_root / 'refresh-status.md'
    dashboard_note.write_text('\n'.join(dashboard_lines) + '\n')
    status_note.write_text('\n'.join(status_lines) + '\n')
    return {
        'dashboard_note': str(dashboard_note),
        'status_note': str(status_note),
        'recent_failures': len(failures),
        'auto_escalation': auto_escalation,
        'history_count': len(history),
    }


def execute_refresh_plan(
    *,
    manifest_path: str | Path,
    curated_stage: str | Path,
    curated_log_dir: str | Path,
    script_dir: str | Path,
    env: dict[str, str] | None = None,
    replay: bool = False,
    chunk_size: int = 50,
) -> dict[str, Any]:
    plan = build_refresh_plan(
        manifest_path=manifest_path,
        curated_stage=curated_stage,
        curated_log_dir=curated_log_dir,
        chunk_size=chunk_size,
    )
    script_root = Path(script_dir).resolve()
    run_env = dict(os.environ if env is None else env)

    refresh_stage_cmd = run_env.get('GBRAIN_CURATED_REFRESH_STAGE_COMMAND', f'bash -ic "{script_root / "refresh-stage.sh"}"')
    import_extract_cmd = run_env.get('GBRAIN_CURATED_IMPORT_EXTRACT_COMMAND', f'bash -ic "{script_root / "import-extract.sh"}"')
    smoke_cmd = run_env.get('GBRAIN_CURATED_SMOKE_COMMAND', f'bash -ic "{script_root / "refresh-smoke-check.sh"}"')
    status_cmd = run_env.get('GBRAIN_CURATED_STATUS_COMMAND', f'bash -ic "{script_root / "gbrain-curated"} status"')

    steps: dict[str, Any] = {}
    overall_ok = True
    failure_category = None
    stderr_summary = ''

    for include_file in plan['include_files']:
        run_env['CURATED_MANIFEST_INCLUDE_FILE'] = include_file
        step = _run_shell(refresh_stage_cmd, env=run_env, cwd=str(script_root))
        step['failure_category'] = _step_failure_category('refresh_stage', step['ok'])
        steps[f'refresh_stage:{Path(include_file).name}'] = step
        if 'refresh_stage' not in steps:
            steps['refresh_stage'] = step
        if not step['ok']:
            overall_ok = False
            failure_category = step['failure_category']
            stderr_summary = step['stderr_summary']
            break

    if overall_ok:
        import_extract = _run_shell(import_extract_cmd, env=run_env, cwd=str(script_root))
        import_extract['failure_category'] = _step_failure_category('import_extract', import_extract['ok'])
        steps['import_extract'] = import_extract
        if not import_extract['ok']:
            overall_ok = False
            failure_category = import_extract['failure_category']
            stderr_summary = import_extract['stderr_summary']

    if overall_ok:
        smoke = _run_shell(smoke_cmd, env=run_env, cwd=str(script_root))
        smoke['failure_category'] = _step_failure_category('smoke', smoke['ok'])
        steps['smoke'] = smoke
        if not smoke['ok']:
            overall_ok = False
            failure_category = smoke['failure_category']
            stderr_summary = smoke['stderr_summary']

    if overall_ok:
        status_step = _run_shell(status_cmd, env=run_env, cwd=str(script_root))
        status_step['failure_category'] = _step_failure_category('status', status_step['ok'])
        steps['status'] = status_step
        if not status_step['ok']:
            overall_ok = False
            failure_category = status_step['failure_category']
            stderr_summary = status_step['stderr_summary']

    status_json = _status_json(Path(curated_log_dir))
    logs = {
        'refresh': str(Path(curated_log_dir) / 'refresh-run-log.jsonl'),
        'smoke_json': str(Path(curated_log_dir) / 'refresh-smoke-last.json'),
        'regression_json': str(Path(curated_log_dir) / 'query-regression-last.json'),
    }
    payload = {
        'ok': overall_ok,
        **plan,
        'replay': replay,
        'failure_category': failure_category,
        'stderr_summary': stderr_summary,
        'status': status_json,
        'logs': logs,
        'steps': steps,
    }
    write_refresh_run_log(plan['log_path'], {
        'manifest_path': plan['manifest_path'],
        'ok': overall_ok,
        'anchor_path': plan['anchor_path'],
        'changed_count': plan['changed_count'],
        'include_files': plan['include_files'],
        'chunk_count': plan['chunk_count'],
        'failure_category': failure_category,
        'stderr_summary': stderr_summary,
        'replay': replay,
    })
    return payload


__all__ = [
    'build_control_plane_artifacts',
    'build_refresh_plan',
    'execute_refresh_plan',
    'gc_old_manifests',
    'summarize_stderr',
    'write_refresh_run_log',
]
