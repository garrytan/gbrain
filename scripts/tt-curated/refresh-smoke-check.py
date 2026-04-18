#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/home/tt/workspace/tools/gbrain')
CASES_PATH = Path('/home/tt/workspace/tools/gbrain/scripts/tt-curated/query-cases.json')
COMMON_PATH = Path('/home/tt/workspace/tools/gbrain/scripts/tt-curated/common.sh')
OUTPUT_PATH = Path('/home/tt/workspace/tools/gbrain-curated-logs/refresh-smoke-last.json')


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


def main():
    env = load_env_from_common()
    cases = [
        case for case in json.loads(CASES_PATH.read_text())
        if 'smoke' in case.get('scope', [])
    ]
    results = []
    all_ok = True
    for case in cases:
        code, stdout, stderr = run_query(env, case['query'])
        hits = parse_hits(stdout)
        slugs = [h['slug'] for h in hits]
        matched = [slug for slug in case['expect_any'] if slug in slugs]
        ok = code == 0 and len(hits) > 0 and len(matched) > 0
        all_ok = all_ok and ok
        results.append({
            'id': case['id'],
            'priority': case.get('priority', 'high'),
            'query': case['query'],
            'ok': ok,
            'matched_expected': matched,
            'top_hits': hits[:5],
            'stderr': stderr.strip(),
        })

    summary = {
        'ok': all_ok,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'total': len(results),
        'passed': sum(1 for r in results if r['ok']),
        'failed': sum(1 for r in results if not r['ok']),
        'results': results,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
