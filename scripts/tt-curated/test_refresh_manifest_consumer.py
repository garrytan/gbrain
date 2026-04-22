from pathlib import Path
import json
import os
import sys
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parent))
from refresh_manifest_consumer import (
    build_control_plane_artifacts,
    build_refresh_plan,
    execute_refresh_plan,
    gc_old_manifests,
    summarize_stderr,
    write_refresh_run_log,
)


def _manifest(tmp_path: Path, changed_count: int = 1) -> Path:
    daily = tmp_path / 'daily.md'
    daily.write_text('# daily')
    changed = []
    for i in range(changed_count):
        note = tmp_path / f'note-{i}.md'
        note.write_text(f'# note {i}')
        changed.append(str(note.resolve()))
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({
        'anchor_path': str(daily.resolve()),
        'changed_note_paths': changed,
        'policy': 'daily-summary-anchor',
    }))
    return manifest


def test_build_refresh_plan_creates_include_files_for_anchor_and_changed_notes(tmp_path):
    stage = tmp_path / 'stage'
    log_dir = tmp_path / 'logs'
    manifest = _manifest(tmp_path)

    plan = build_refresh_plan(manifest_path=manifest, curated_stage=stage, curated_log_dir=log_dir)
    include_files = [Path(p) for p in plan['include_files']]
    assert len(include_files) == 1
    lines = include_files[0].read_text().splitlines()
    assert str((tmp_path / 'daily.md').resolve()) in lines
    assert str((tmp_path / 'note-0.md').resolve()) in lines
    assert plan['changed_count'] == 1
    assert plan['anchor_path'] == str((tmp_path / 'daily.md').resolve())


def test_build_refresh_plan_chunks_large_changed_sets(tmp_path):
    stage = tmp_path / 'stage'
    log_dir = tmp_path / 'logs'
    manifest = _manifest(tmp_path, changed_count=5)

    plan = build_refresh_plan(manifest_path=manifest, curated_stage=stage, curated_log_dir=log_dir, chunk_size=2)
    assert len(plan['include_files']) == 3
    assert plan['chunk_count'] == 3
    assert plan['chunk_size'] == 2


def test_execute_refresh_plan_reports_step_failure_category_and_stderr_summary(tmp_path):
    stage = tmp_path / 'stage'
    log_dir = tmp_path / 'logs'
    manifest = _manifest(tmp_path)
    env = {
        **os.environ,
        'GBRAIN_CURATED_REFRESH_STAGE_COMMAND': "python -c \"import sys; sys.stderr.write('manifest include failed badly\\nmore detail'); raise SystemExit(2)\"",
    }
    payload = execute_refresh_plan(
        manifest_path=manifest,
        curated_stage=stage,
        curated_log_dir=log_dir,
        script_dir=Path(__file__).resolve().parent,
        env=env,
    )
    assert payload['ok'] is False
    assert payload['failure_category'] == 'refresh_stage_error'
    assert payload['steps']['refresh_stage']['failure_category'] == 'refresh_stage_error'
    assert 'manifest include failed badly' in payload['stderr_summary']


def test_gc_old_manifests_removes_old_files(tmp_path):
    root = tmp_path / 'manifests'
    root.mkdir()
    old = root / 'old.json'
    new = root / 'new.json'
    old.write_text('{}')
    new.write_text('{}')
    os.utime(old, (1, 1))

    result = gc_old_manifests(root, keep=1)
    assert result['removed_count'] == 1
    assert old.name in result['removed']
    assert new.exists()


def test_write_refresh_run_log_appends_jsonl_record(tmp_path):
    log_path = tmp_path / 'refresh-run-log.jsonl'
    write_refresh_run_log(log_path, {'ok': True, 'mode': 'batch', 'manifest_path': '/tmp/m.json'})
    write_refresh_run_log(log_path, {'ok': False, 'failure_category': 'timeout'})
    lines = log_path.read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])['manifest_path'] == '/tmp/m.json'
    assert json.loads(lines[1])['failure_category'] == 'timeout'


def test_summarize_stderr_keeps_first_nonempty_lines():
    summary = summarize_stderr('line1\n\nline2\nline3\nline4', max_lines=2)
    assert summary == 'line1 | line2'


def test_build_control_plane_artifacts_writes_dashboard_and_status_notes(tmp_path):
    log_dir = tmp_path / 'logs'
    log_dir.mkdir()
    run_log = log_dir / 'refresh-run-log.jsonl'
    run_log.write_text(
        '\n'.join([
            json.dumps({'manifest_path': '/tmp/m1.json', 'ok': False, 'failure_category': 'smoke_error', 'stderr_summary': 'smoke failed', 'replay': False, 'chunk_count': 2}),
            json.dumps({'manifest_path': '/tmp/m2.json', 'ok': True, 'failure_category': None, 'stderr_summary': '', 'replay': True, 'chunk_count': 1}),
        ]) + '\n'
    )
    (log_dir / 'refresh-smoke-last.json').write_text(json.dumps({'ok': True, 'passed': 4, 'total': 4}))
    (log_dir / 'query-regression-last.json').write_text(json.dumps({'ok': True, 'passed': 11, 'total': 11, 'severe_drift_count': 0}))
    (log_dir / 'weekly-baseline-review.json').write_text(json.dumps({'generated_at': '2026-04-22T00:00:00Z'}))

    out = build_control_plane_artifacts(log_dir=log_dir, output_dir=tmp_path / 'control', failure_threshold=1)
    dashboard = Path(out['dashboard_note'])
    status = Path(out['status_note'])
    assert dashboard.exists()
    assert status.exists()
    dashboard_text = dashboard.read_text()
    status_text = status.read_text()
    assert 'Recent Failures' in dashboard_text
    assert 'smoke_error' in dashboard_text
    assert 'Replay / Chunk History' in dashboard_text
    assert 'Auto-escalation: ON' in dashboard_text
    assert 'Refresh Status' in status_text
    assert 'smoke: ok (4/4)' in status_text
    assert 'regression: ok (11/11)' in status_text
