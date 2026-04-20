#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config_loader import load_config, paths

CONFIG = load_config()
PATHS = paths(CONFIG)
ROOT = Path(PATHS['GBRAIN_ROOT'])
CASES_PATH = Path(PATHS['QUERY_CASES_PATH'])
COMMON_PATH = Path(PATHS['COMMON_PATH'])
OUTPUT_PATH = Path(PATHS['REGRESSION_LAST_JSON'])
BASELINE_PATH = Path(PATHS['REGRESSION_BASELINE_JSON'])
DEFAULT_DRIFT_RANK_TOLERANCE = 3
DEFAULT_DRIFT_SCORE_DROP_TOLERANCE = 0.12
PRIORITY_DRIFT_RULES = {
    'critical': {'rank_tolerance': 2, 'score_drop_tolerance': 0.08},
    'high': {'rank_tolerance': 3, 'score_drop_tolerance': 0.12},
    'medium': {'rank_tolerance': 4, 'score_drop_tolerance': 0.18},
}


def load_env_from_common():
    env = os.environ.copy()
    cmd = f"bash -ic 'source {COMMON_PATH}; env'"
    out = subprocess.check_output(cmd, shell=True, text=True)
    for line in out.splitlines():
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k] = v
    return env


def run_query(env, query):
    cmd = [
        '/home/tt/workspace/tools/gbrain-local-bun/bin/bun',
        'run',
        'src/cli.ts',
        'query',
        query,
    ]
    proc = subprocess.run(cmd, cwd=ROOT, env=env, text=True, capture_output=True)
    return proc.returncode, proc.stdout, proc.stderr


def parse_hits(stdout):
    hits = []
    for line in stdout.splitlines():
        m = re.match(r'^\[([0-9.]+)\]\s+([^\s]+)\s+--\s+(.*)$', line)
        if m:
            hits.append({
                'score': float(m.group(1)),
                'slug': m.group(2),
                'snippet': m.group(3),
            })
    return hits


def best_expected_rank_and_score(expect_any, hits):
    for idx, hit in enumerate(hits, start=1):
        if hit['slug'] in expect_any:
            return idx, hit['score'], hit['slug']
    return None, None, None


def load_baseline():
    if not BASELINE_PATH.exists():
        return None
    return json.loads(BASELINE_PATH.read_text())


def baseline_map(baseline):
    if not baseline:
        return {}
    return {item['id']: item for item in baseline.get('results', [])}


def build_baseline(summary):
    return {
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'default_rank_tolerance': DEFAULT_DRIFT_RANK_TOLERANCE,
        'default_score_drop_tolerance': DEFAULT_DRIFT_SCORE_DROP_TOLERANCE,
        'priority_drift_rules': PRIORITY_DRIFT_RULES,
        'results': [
            {
                'id': result['id'],
                'priority': result['priority'],
                'query': result['query'],
                'best_expected_rank': result['best_expected_rank'],
                'best_expected_score': result['best_expected_score'],
                'best_expected_slug': result['best_expected_slug'],
                'top_hits': result['top_hits'],
            }
            for result in summary['results']
        ]
    }


def maybe_write_baseline(summary, force=False):
    if force or not BASELINE_PATH.exists():
        BASELINE_PATH.parent.mkdir(parents=True, exist_ok=True)
        BASELINE_PATH.write_text(json.dumps(build_baseline(summary), indent=2, ensure_ascii=False))
        return True
    return False


def main():
    write_baseline = '--write-baseline' in sys.argv
    env = load_env_from_common()
    cases = [
        case for case in (yaml.safe_load(CASES_PATH.read_text()) or [])
        if 'regression' in case.get('scope', ['regression'])
    ]
    baseline = load_baseline()
    baseline_by_id = baseline_map(baseline)
    results = []
    functional_ok = True
    severe_drift_count = 0

    for case in cases:
        code, stdout, stderr = run_query(env, case['query'])
        hits = parse_hits(stdout)
        slugs = [h['slug'] for h in hits]
        matched = [slug for slug in case['expect_any'] if slug in slugs]
        ok = code == 0 and len(hits) > 0 and len(matched) > 0
        functional_ok = functional_ok and ok
        priority = case.get('priority', 'high')
        drift_rules = PRIORITY_DRIFT_RULES.get(priority, {
            'rank_tolerance': DEFAULT_DRIFT_RANK_TOLERANCE,
            'score_drop_tolerance': DEFAULT_DRIFT_SCORE_DROP_TOLERANCE,
        })

        best_rank, best_score, best_slug = best_expected_rank_and_score(case['expect_any'], hits)
        drift = None
        drift_severity = 'none'
        baseline_case = baseline_by_id.get(case['id'])
        if baseline_case and ok:
            base_rank = baseline_case.get('best_expected_rank')
            base_score = baseline_case.get('best_expected_score')
            rank_shift = None if base_rank is None or best_rank is None else best_rank - base_rank
            score_drop = None if base_score is None or best_score is None else base_score - best_score
            severe = False
            reasons = []
            if rank_shift is not None and rank_shift >= drift_rules['rank_tolerance']:
                severe = True
                reasons.append(f'rank+{rank_shift}')
            if score_drop is not None and score_drop >= drift_rules['score_drop_tolerance']:
                severe = True
                reasons.append(f'score-{score_drop:.3f}')
            if severe:
                drift_severity = 'severe'
                severe_drift_count += 1
            elif rank_shift not in (None, 0) or (score_drop is not None and score_drop > 0):
                drift_severity = 'mild'
            drift = {
                'baseline_best_expected_rank': base_rank,
                'baseline_best_expected_score': base_score,
                'baseline_best_expected_slug': baseline_case.get('best_expected_slug'),
                'current_best_expected_rank': best_rank,
                'current_best_expected_score': best_score,
                'current_best_expected_slug': best_slug,
                'rank_shift': rank_shift,
                'score_drop': score_drop,
                'priority': priority,
                'rank_tolerance': drift_rules['rank_tolerance'],
                'score_drop_tolerance': drift_rules['score_drop_tolerance'],
                'severity': drift_severity,
                'reasons': reasons,
            }

        results.append({
            'id': case['id'],
            'priority': priority,
            'query': case['query'],
            'ok': ok,
            'expected_any': case['expect_any'],
            'matched_expected': matched,
            'best_expected_rank': best_rank,
            'best_expected_score': best_score,
            'best_expected_slug': best_slug,
            'top_hits': hits[:8],
            'stderr': stderr.strip(),
            'drift': drift,
        })

    overall_ok = functional_ok and severe_drift_count == 0
    severe_drift_cases = []
    for result in results:
        drift = result.get('drift')
        if drift and drift.get('severity') == 'severe':
            severe_drift_cases.append({
                'id': result['id'],
                'priority': result.get('priority'),
                'best_expected_slug': result.get('best_expected_slug'),
                'rank_shift': drift.get('rank_shift'),
                'score_drop': drift.get('score_drop'),
                'reasons': drift.get('reasons', []),
            })

    summary = {
        'ok': overall_ok,
        'functional_ok': functional_ok,
        'drift_ok': severe_drift_count == 0,
        'total': len(results),
        'passed': sum(1 for r in results if r['ok']),
        'failed': sum(1 for r in results if not r['ok']),
        'severe_drift_count': severe_drift_count,
        'severe_drift_cases': severe_drift_cases,
        'baseline_path': str(BASELINE_PATH),
        'results': results,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    baseline_written = maybe_write_baseline(summary, force=write_baseline)
    summary['baseline_written'] = baseline_written
    OUTPUT_PATH.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if overall_ok else 1


if __name__ == '__main__':
    sys.exit(main())
