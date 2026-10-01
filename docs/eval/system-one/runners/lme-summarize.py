"""Summarize System One LongMemEval arms (lme-arms.sh output).

python3 docs/eval/system-one/runners/lme-summarize.py <out-dir> <baseline-arm> <arm> [<arm> ...]

Per arm, over answerable (non _abs) questions: strict recall_all@5 and
recall_any@5, R@1 (the top retrieved session is an answer session), pool
recall at fused depth 30/50/100/300 (every answer session present), the
reranker's top-1 rate on questions whose answer session is in the pool,
latency and decide cost per question, and a paired comparison against the
baseline arm (wins, losses, exact two-sided McNemar p). Judged arms add
answer accuracy (the LLM judge's verdicts, abstention questions included).
"""
import glob, json, math, sys


def load(out, arm):
    rows = []
    for f in sorted(glob.glob(f"{out}/{arm}.*.ndjson")):
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if "question_id" in r:
                rows.append(r)
    return {r["question_id"]: r for r in rows}


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))]


def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def judged(r):
    for k in ("judge_correct", "judge_label", "judge_verdict", "judgment", "judge"):
        v = r.get(k)
        if isinstance(v, bool):
            return v
        if isinstance(v, dict) and isinstance(v.get("correct"), bool):
            return v["correct"]
        if isinstance(v, str) and v in ("yes", "no", "correct", "incorrect"):
            return v in ("yes", "correct")
    return None


def top1(r):
    ret = r.get("retrieved") or []
    return bool(ret) and ret[0].get("session_id") in set(r.get("answer_session_ids") or [])


def summarize(rows):
    ans = [r for r in rows.values() if not r["question_id"].endswith("_abs") and not r.get("error")]
    errors = sum(1 for r in rows.values() if r.get("error"))
    out = {"questions": len(rows), "answerable": len(ans), "errors": errors}
    out["recall_all@5"] = sum(1 for r in ans if r.get("recall_all_hit")) / max(1, len(ans))
    out["recall_all@5_n"] = sum(1 for r in ans if r.get("recall_all_hit"))
    out["recall_any@5"] = sum(1 for r in ans if r.get("recall_any_hit")) / max(1, len(ans))
    out["R@1"] = sum(1 for r in ans if top1(r)) / max(1, len(ans))
    pools = [r["pool_recall"] for r in ans if r.get("pool_recall")]
    if pools:
        out["fused_pool_size_mean"] = sum(p.get("fused_pool_size", 0) for p in pools) / len(pools)
        for d in ("30", "50", "100", "300"):
            out[f"pool_recall_all@{d}"] = sum(1 for p in pools if (p.get("at", {}).get(d) or {}).get("all")) / len(pools)
        present = [r for r in ans if r.get("pool_recall") and (r["pool_recall"].get("at", {}).get("300") or {}).get("any")]
        out["top1_when_present"] = f"{sum(1 for r in present if top1(r))}/{len(present)}"
    lat = [((r.get("decide") or {}).get("rerank") or {}).get("latency_ms") for r in ans]
    lat = [x for x in lat if isinstance(x, (int, float))]
    if lat:
        out["jev_rerank_latency_ms"] = {"p50": pct(lat, 0.5), "p95": pct(lat, 0.95), "p99": pct(lat, 0.99)}
    cost = 0.0
    for r in rows.values():
        for s in (r.get("decide") or {}).values():
            if isinstance(s, dict) and isinstance(s.get("cost_usd"), (int, float)):
                cost += s["cost_usd"]
    out["decide_cost_usd_total"] = round(cost, 5)
    out["decide_cost_usd_per_question"] = round(cost / max(1, len(rows)), 6)
    j = [judged(r) for r in rows.values()]
    j = [x for x in j if x is not None]
    if j:
        out["answer_accuracy"] = sum(j) / len(j)
        out["answer_accuracy_n"] = f"{sum(j)}/{len(j)}"
    outcomes = {}
    for r in rows.values():
        for slot, s in (r.get("decide") or {}).items():
            if isinstance(s, dict):
                for o, n in (s.get("outcomes") or {}).items():
                    outcomes[f"{slot}:{o}"] = outcomes.get(f"{slot}:{o}", 0) + n
                if s.get("skipped"):
                    outcomes[f"{slot}:skipped:{s['skipped']}"] = outcomes.get(f"{slot}:skipped:{s['skipped']}", 0) + 1
                if s.get("late"):
                    outcomes[f"{slot}:late"] = outcomes.get(f"{slot}:late", 0) + 1
    if outcomes:
        out["decide_outcomes"] = outcomes
    tokens = [r.get("retrieved_tokens") or r.get("reader_context_chars") for r in rows.values()]
    tokens = [t for t in tokens if isinstance(t, (int, float))]
    if tokens:
        out["mean_reader_context"] = sum(tokens) / len(tokens)
    out["mean_distinct_sessions_top5"] = sum(r.get("distinct_sessions_in_top_k") or 0 for r in ans) / max(1, len(ans))
    return out


def paired(base, arm, key):
    shared = [q for q in base if q in arm and not q.endswith("_abs")]
    f = {"recall_all": lambda r: bool(r.get("recall_all_hit")), "R@1": top1, "answer": judged}[key]
    wins = sum(1 for q in shared if f(arm[q]) and not f(base[q]))
    losses = sum(1 for q in shared if f(base[q]) and not f(arm[q]))
    return {"n": len(shared), "wins": wins, "losses": losses, "mcnemar_p": round(mcnemar(wins, losses), 4)}


out, base_name, arms = sys.argv[1], sys.argv[2], sys.argv[3:]
base = load(out, base_name)
report = {base_name: summarize(base)}
for a in arms:
    rows = load(out, a)
    report[a] = summarize(rows)
    report[a]["vs_" + base_name] = {k: paired(base, rows, k) for k in ("recall_all", "R@1")}
    if "answer_accuracy" in report[a]:
        report[a]["vs_" + base_name]["answer"] = paired(base, rows, "answer")
print(json.dumps(report, indent=2))
