"""S6 BrainBench know-to-ask matched pair summary on the EVAL half only.

python3 docs/eval/system-one/runners/s6-brainbench-summary.py <dataset.jsonl> <off.json> <on.json> [<off2> <on2> ...]
Failure = a should_retrieve turn with no gold slug injected; false fire = a
not-needed turn with anything injected (BrainBench's know-to-ask definitions),
restricted to turns whose fixture is in the dataset's eval half.
"""
import json, sys, statistics

ds = [json.loads(l) for l in open(sys.argv[1])]
eval_turns = {d["id"] for d in ds if d["split"] == "eval"}

def summarize(path):
    rows = [r for r in json.load(open(path))["turn_rows"] if f'{r["fixture_id"]}#{r["turn_id"]}' in eval_turns]
    need = [r for r in rows if r["gold"]["should_retrieve"]]
    notneed = [r for r in rows if not r["gold"]["should_retrieve"]]
    fail = sum(1 for r in need if not set(r["gold"].get("gold_slugs") or []) & set(r["injected_slugs"]))
    ff = sum(1 for r in notneed if r["injected_slugs"])
    lat = sorted(r["latency_ms"] for r in rows)
    q = lambda p: lat[min(len(lat) - 1, int(p * len(lat)))]
    outcomes = {}
    for r in rows:
        s = (r.get("decide") or {}).get("recall_needed") or {}
        k = s.get("skipped") or ",".join((s.get("outcomes") or {}).keys()) or "off"
        outcomes[k] = outcomes.get(k, 0) + 1
    return {"turns": len(rows), "needed": len(need), "know_to_ask_failures": fail, "failure_rate": round(fail / max(1, len(need)), 4),
            "false_fires": ff, "false_fire_rate": round(ff / max(1, len(notneed)), 4),
            "avg_injected_tokens": round(statistics.mean(r["injected_tokens"] for r in rows), 2),
            "latency_ms": {"p50": round(q(0.5), 1), "p95": round(q(0.95), 1), "p99": round(q(0.99), 1)}, "outcomes": outcomes}

out = {p.split("/")[-1]: summarize(p) for p in sys.argv[2:]}
print(json.dumps(out, indent=2))
