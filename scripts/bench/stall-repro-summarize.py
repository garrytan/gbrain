#!/usr/bin/env python3
"""Summarize one managed-sync-stall-repro capture directory (#6278 Phase 4.1).

    python3 scripts/bench/stall-repro-summarize.py .context/bench/stall-p10 [more dirs...]

Reads report.json and samples.jsonl and prints, per pass: pages committed,
wall and steady pages/min (steady = the middle 80% of the pass by time), the
longest window without a committed sync page, the exit code, the drain's
closing line, holds by code/reason, `preparation_stalled` receipts and the
`stalled <N>s on <step>` progress lines; then the run-level fence, legacy-row,
writer-status and retry-held results. Numbers only; no page content.
"""
import json
import sys
from pathlib import Path


def summarize(out: Path) -> dict:
    report = json.loads((out / 'report.json').read_text())
    samples = [json.loads(line) for line in (out / 'samples.jsonl').read_text().splitlines() if line.strip()]
    passes = []
    for p in report.get('passes', []):
        rows = [s for s in samples if s.get('pass') == p['pass'] and isinstance(s.get('committed'), int)]
        steady = None
        if len(rows) >= 5:
            t0, t1 = rows[0]['t'], rows[-1]['t']
            mid = [s for s in rows if t0 + (t1 - t0) * 0.1 <= s['t'] <= t0 + (t1 - t0) * 0.9]
            if len(mid) >= 2 and mid[-1]['t'] > mid[0]['t']:
                steady = round((mid[-1]['committed'] - mid[0]['committed']) / ((mid[-1]['t'] - mid[0]['t']) / 60000), 1)
        passes.append({
            'pass': p['pass'], 'exit_code': p.get('code'), 'killed_by': p.get('killedBy'), 'status': p.get('status'), 'outcome': p.get('outcome'),
            'pages_committed': (p.get('committedAtEnd') or 0) - (p.get('committedAtStart') or 0), 'wall_s': p.get('wall_s'),
            'pages_per_min_wall': p.get('pages_per_min'), 'pages_per_min_steady': steady,
            'longest_no_commit_s': round(max((s.get('committed_stale_ms') or 0) for s in rows) / 1000) if rows else None,
            'sync_deadline_stop': p.get('sync_deadline_stop'), 'drain_lines': p.get('drain_lines'), 'stalled_progress_lines': p.get('stalled_progress_lines'),
            'stalled_by_step': p.get('stalled_by_step'), 'restart_required': p.get('restart_required'),
            'holds': p.get('holds_by_code_reason'), 'preparation_stalled_receipts': p.get('stalled_receipts'),
        })
    result = report.get('result', {})
    return {
        'dir': str(out), 'label': report.get('label'), 'cli_commit': report.get('cli_commit'), 'cli_version': report.get('cli_version'), 'params': report.get('params'),
        'passes': passes, 'committed_total': result.get('committed_sync_requests'), 'backlog_entries': result.get('backlog_entries'),
        'failed_receipts': result.get('failed_receipts_by_kind_and_error'), 'states': result.get('states'),
        'preparing_claims_observed': result.get('preparing_claims_observed'), 'doctor_fence_integrity': result.get('doctor_fence_integrity'),
        'legacy_outcome': report.get('legacy_outcome'), 'legacy_pending_at_end': result.get('legacy_pending_at_end'),
        'adoption_runs': result.get('adoption_summary'), 'fence_repair': (report.get('fence_repair') or {}).get('phase'),
        'retry_held': report.get('retry_held'), 'chaos': result.get('chaos'), 'stalls': [{k: v for k, v in s.items() if k != 'running'} for s in result.get('stalls', [])],
    }


if __name__ == '__main__':
    print(json.dumps([summarize(Path(d)) for d in sys.argv[1:]], indent=1))
