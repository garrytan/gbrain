#!/usr/bin/env python3
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

LOG_DIR = Path('/home/tt/workspace/tools/gbrain-curated-logs')
REG_LAST = LOG_DIR / 'query-regression-last.json'
REG_BASE = LOG_DIR / 'query-regression-baseline.json'
SMOKE_LAST = LOG_DIR / 'refresh-smoke-last.json'
OUT = LOG_DIR / 'weekly-baseline-review.json'


def load(path):
    if not path.exists():
        return None
    return json.loads(path.read_text())


def main():
    reg_last = load(REG_LAST) or {}
    reg_base = load(REG_BASE) or {}
    smoke_last = load(SMOKE_LAST) or {}

    severity_counts = Counter()
    priority_counts = Counter()
    for result in reg_last.get('results', []):
        drift = result.get('drift') or {}
        severity_counts[drift.get('severity', 'none')] += 1
        priority_counts[result.get('priority', 'unknown')] += 1

    review = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'regression': {
            'ok': reg_last.get('ok'),
            'functional_ok': reg_last.get('functional_ok'),
            'drift_ok': reg_last.get('drift_ok'),
            'total': reg_last.get('total'),
            'passed': reg_last.get('passed'),
            'failed': reg_last.get('failed'),
            'severe_drift_count': reg_last.get('severe_drift_count'),
            'severity_counts': dict(severity_counts),
            'priority_counts': dict(priority_counts),
            'baseline_captured_at': reg_base.get('captured_at'),
        },
        'smoke': {
            'ok': smoke_last.get('ok'),
            'total': smoke_last.get('total'),
            'passed': smoke_last.get('passed'),
            'failed': smoke_last.get('failed'),
            'failed_ids': [r['id'] for r in smoke_last.get('results', []) if not r.get('ok')],
        },
        'notes': [
            'Review critical/high cases if severe drift count is non-zero.',
            'Refresh baseline only after intentional retrieval-quality validation.',
            'Use this file as a weekly local snapshot; no chat delivery by default.'
        ]
    }
    OUT.write_text(json.dumps(review, indent=2, ensure_ascii=False))
    print(json.dumps(review, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
