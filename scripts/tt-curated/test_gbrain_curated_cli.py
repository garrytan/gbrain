from pathlib import Path
import subprocess
import json
import os


def test_gbrain_curated_refresh_accepts_manifest_and_emits_status_json(tmp_path):
    script = Path(__file__).resolve().parent / 'gbrain-curated'
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({
        'anchor_path': str((tmp_path / 'daily.md').resolve()),
        'changed_note_paths': [str((tmp_path / 'note.md').resolve())],
        'policy': 'daily-summary-anchor',
    }))
    (tmp_path / 'daily.md').write_text('# daily')
    (tmp_path / 'note.md').write_text('# note')

    env = {
        **dict(os.environ),
        'GBRAIN_CURATED_REFRESH_STAGE_COMMAND': "python -c \"print('stage ok')\"",
        'GBRAIN_CURATED_IMPORT_EXTRACT_COMMAND': "python -c \"print('import ok')\"",
        'GBRAIN_CURATED_SMOKE_COMMAND': "python -c \"import json; print(json.dumps({'ok': True}))\"",
        'GBRAIN_CURATED_STATUS_COMMAND': "python -c \"print('status ok')\"",
    }
    proc = subprocess.run([str(script), 'refresh', str(manifest)], capture_output=True, text=True, env=env)

    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload['ok'] is True
    assert payload['manifest_path'] == str(manifest.resolve())
    assert payload['include_files']
    assert 'status' in payload
    assert 'logs' in payload


def test_gbrain_curated_refresh_replay_accepts_manifest(tmp_path):
    script = Path(__file__).resolve().parent / 'gbrain-curated'
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({
        'anchor_path': str((tmp_path / 'daily.md').resolve()),
        'changed_note_paths': [str((tmp_path / 'note.md').resolve())],
        'policy': 'daily-summary-anchor',
    }))
    (tmp_path / 'daily.md').write_text('# daily')
    (tmp_path / 'note.md').write_text('# note')

    env = {
        **dict(os.environ),
        'GBRAIN_CURATED_REFRESH_STAGE_COMMAND': "python -c \"print('stage ok')\"",
        'GBRAIN_CURATED_IMPORT_EXTRACT_COMMAND': "python -c \"print('import ok')\"",
        'GBRAIN_CURATED_SMOKE_COMMAND': "python -c \"import json; print(json.dumps({'ok': True}))\"",
        'GBRAIN_CURATED_STATUS_COMMAND': "python -c \"print('status ok')\"",
    }
    proc = subprocess.run([str(script), 'refresh-replay', str(manifest)], capture_output=True, text=True, env=env)

    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload['ok'] is True
    assert payload['replay'] is True


def test_gbrain_curated_dashboard_writes_control_plane_notes(tmp_path):
    script = Path(__file__).resolve().parent / 'gbrain-curated'
    log_dir = tmp_path / 'logs'
    log_dir.mkdir()
    (log_dir / 'refresh-run-log.jsonl').write_text(json.dumps({'manifest_path': '/tmp/m1.json', 'ok': False, 'failure_category': 'smoke_error', 'stderr_summary': 'smoke failed', 'replay': False, 'chunk_count': 2}) + '\n')
    (log_dir / 'refresh-smoke-last.json').write_text(json.dumps({'ok': True, 'passed': 4, 'total': 4}))
    (log_dir / 'query-regression-last.json').write_text(json.dumps({'ok': True, 'passed': 11, 'total': 11, 'severe_drift_count': 0}))
    (log_dir / 'weekly-baseline-review.json').write_text(json.dumps({'generated_at': '2026-04-22T00:00:00Z'}))
    env = {**dict(os.environ), 'CURATED_LOG_DIR': str(log_dir), 'CURATED_STAGE': str(tmp_path / 'stage')}

    proc = subprocess.run([str(script), 'dashboard'], capture_output=True, text=True, env=env)

    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert Path(payload['dashboard_note']).exists()
    assert Path(payload['status_note']).exists()
    assert payload['auto_escalation'] is True
