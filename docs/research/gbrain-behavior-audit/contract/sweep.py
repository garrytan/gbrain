#!/usr/bin/env python3
"""Fault-injection sweep. usage: sweep.py <brain_home> <name> <verify-json-or-''> -- <gbrain args...>
For each distinct SQL statement the command runs, restore the brain from <home>.tpl, rerun the command
with that one statement failing (permission-denied style error), and classify the outcome.
verify: JSON list of gbrain arg lists run (uninjected) after the command, outputs compared to the baseline's."""
import json, os, re, subprocess, sys, hashlib

D = '/var/tmp/audit/contract'
home, name, verify = sys.argv[1], sys.argv[2], sys.argv[3]
args = sys.argv[sys.argv.index('--') + 1:]
verify = json.loads(verify) if verify else []
outdir = f'{D}/sweep/{name}'
os.makedirs(outdir, exist_ok=True)

NORM = [
    (r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'UUID'),
    (r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?', 'TS'),
    (r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?(\+\d+)?', 'TS'),
    (r'"(latency_ms|elapsed_ms|took_ms|ms|duration_ms|total_ms)": ?[\d.]+', r'"\1": N'),
    (r'\(\d+ms\)', '(Nms)'), (r'elapsed_ms=\d+', 'elapsed_ms=N'), (r'\d+(\.\d+)? ?ms\b', 'Nms'),
    (r'"(id|request_id|revision|knowledge_revision|text_projection_revision)": ?"?\w+"?', r'"\1": X'),
    (r'"(score|base_score)": ?[\d.e-]+', r'"\1": S'),
]
def norm(s):
    for a, b in NORM: s = re.sub(a, b, s)
    return s

def restore():
    subprocess.run(['rsync', '-a', '--delete', f'{home}.tpl/', f'{home}/'], check=True)

def run(extra_env, argv):
    env = dict(os.environ); env.update(extra_env)
    p = subprocess.run([f'{D}/inj.sh', home] + argv, capture_output=True, text=True, env=env, timeout=120)
    return p.returncode, p.stdout, p.stderr

def verify_out():
    outs = []
    for v in verify:
        rc, o, e = run({}, v)
        outs.append(f'rc={rc}\n{norm(o)}')
    return '\n=====\n'.join(outs)

restore()
logf = f'{outdir}/base.log'
if os.path.exists(logf): os.remove(logf)
rc0, o0, e0 = run({'INJECT_LOG': logf}, args)
v0 = verify_out()
# second baseline run to learn nondeterminism
restore(); rc0b, o0b, e0b = run({}, args); v0b = verify_out()
flaky_out = norm(o0) != norm(o0b); flaky_v = v0 != v0b
seen = []
for line in open(logf):
    n, h, sql = line.rstrip('\n').split('\t', 2)
    if h not in [x[0] for x in seen]: seen.append((h, sql))
results = []
for h, sql in seen:
    restore()
    fired = f'{outdir}/fired.txt'
    if os.path.exists(fired): os.remove(fired)
    try:
        rc, o, e = run({'INJECT_HASH': h, 'INJECT_FIREDLOG': fired}, args)
    except subprocess.TimeoutExpired:
        results.append({'hash': h, 'sql': sql, 'class': 'TIMEOUT'}); continue
    nf = sum(1 for _ in open(fired)) if os.path.exists(fired) else 0
    v = verify_out() if rc == 0 else None
    same_out = norm(o) == norm(o0)
    degraded = bool(re.search(r'degraded|withheld|partial|best[- ]effort|could not|failed|unavailable|warning', o + e, re.I)) and not re.search(r'degraded|withheld', o0 + e0, re.I)
    new_err = norm(e) != norm(e0)
    if nf == 0: cls = 'NOT_FIRED'
    elif rc != 0: cls = 'LOUD_FAIL'
    elif same_out and (v is None or v == v0): cls = 'SWALLOWED_NO_EFFECT'
    elif not same_out and (flaky_out): cls = 'DIFF_BUT_FLAKY'
    else: cls = 'SILENT_DIFF' if not new_err else 'DIFF_WITH_STDERR'
    if v is not None and v != v0 and not flaky_v: cls += '+VERIFY_DIFF'
    r = {'hash': h, 'sql': sql, 'class': cls, 'rc': rc, 'fired': nf}
    if 'DIFF' in cls:
        with open(f'{outdir}/{h}.out', 'w') as f: f.write(f'### stdout\n{o}\n### stderr\n{e}\n### verify\n{v}\n')
    results.append(r)
with open(f'{outdir}/base.out', 'w') as f: f.write(f'rc={rc0}\n### stdout\n{o0}\n### stderr\n{e0}\n### verify\n{v0}\nflaky_out={flaky_out} flaky_v={flaky_v}\n')
json.dump(results, open(f'{outdir}/results.json', 'w'), indent=1)
from collections import Counter
print(name, 'rc0=', rc0, 'flaky_out=', flaky_out, 'flaky_v=', flaky_v, dict(Counter(r['class'] for r in results)))
for r in results:
    if 'DIFF' in r['class'] or r['class'] == 'TIMEOUT': print('  ', r['class'], r['hash'], r['sql'][:130])
