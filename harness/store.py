import os, sys, sqlite3, json, uuid, time
from datetime import datetime, timezone
from pathlib import Path

def _verbose() -> bool:
    return os.environ.get("HARNESS_VERBOSE", "") == "1"

DB_PATH = Path.home() / ".gbrain" / "harness.db"

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task TEXT NOT NULL,"
    "status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,"
    "total_input_tokens INTEGER DEFAULT 0,total_output_tokens INTEGER DEFAULT 0);"
    "CREATE TABLE IF NOT EXISTS steps(run_id TEXT NOT NULL,step_idx INTEGER NOT NULL,"
    "role TEXT NOT NULL,content TEXT NOT NULL,stop_reason TEXT,input_tokens INTEGER,"
    "output_tokens INTEGER,latency_ms INTEGER,ts TEXT NOT NULL,PRIMARY KEY(run_id,step_idx));"
    "CREATE TABLE IF NOT EXISTS tool_calls(run_id TEXT NOT NULL,step_idx INTEGER NOT NULL,"
    "call_idx INTEGER NOT NULL,name TEXT NOT NULL,input TEXT NOT NULL,output TEXT NOT NULL,"
    "latency_ms INTEGER,ts TEXT NOT NULL,PRIMARY KEY(run_id,step_idx,call_idx));"
)


def _conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init():
    with _conn() as conn:
        conn.executescript(_SCHEMA)


_init()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _block_to_dict(b) -> dict:
    return b.model_dump() if hasattr(b, "model_dump") else vars(b)


def create_run(task: str) -> str:
    run_id = uuid.uuid4().hex[:8]
    with _conn() as conn:
        conn.execute(
            "INSERT INTO runs (id, task, status, started_at) VALUES (?, ?, 'running', ?)",
            (run_id, task, _now()),
        )
    return run_id


def finish_run(run_id: str, status: str):
    with _conn() as conn:
        row = conn.execute(
            "SELECT SUM(input_tokens), SUM(output_tokens) FROM steps WHERE run_id=?",
            (run_id,),
        ).fetchone()
        conn.execute(
            "UPDATE runs SET status=?, ended_at=?, total_input_tokens=?, total_output_tokens=? WHERE id=?",
            (status, _now(), row[0] or 0, row[1] or 0, run_id),
        )


def log_step(run_id: str, step_idx: int, response, latency_ms: int = 0):
    u = response.usage
    if _verbose():
        print(f"[step {step_idx}] {u.input_tokens}in/{u.output_tokens}out {latency_ms}ms stop={response.stop_reason}", file=sys.stderr)
    with _conn() as conn:
        conn.execute(
            "INSERT INTO steps (run_id,step_idx,role,content,stop_reason,input_tokens,output_tokens,latency_ms,ts) "
            "VALUES (?,?,'assistant',?,?,?,?,?,?)",
            (run_id, step_idx,
             json.dumps([_block_to_dict(b) for b in response.content]),
             response.stop_reason, u.input_tokens, u.output_tokens, latency_ms, _now()),
        )


def log_tool_call(run_id: str, step_idx: int, name: str, inp: dict, output: str, latency_ms: int = 0):
    if _verbose():
        keys = list(inp.keys())
        print(f"  → {name}({keys}) {latency_ms}ms  {output[:80].strip()!r}", file=sys.stderr)
    with _conn() as conn:
        idx = conn.execute(
            "SELECT COUNT(*) FROM tool_calls WHERE run_id=? AND step_idx=?",
            (run_id, step_idx),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO tool_calls (run_id,step_idx,call_idx,name,input,output,latency_ms,ts) VALUES (?,?,?,?,?,?,?,?)",
            (run_id, step_idx, idx, name, json.dumps(inp), output, latency_ms, _now()),
        )


def replay_run(run_id: str) -> list:
    """Reconstruct the messages list from a stored run (for resume or inspection)."""
    data = get_run(run_id)
    messages = [{"role": "user", "content": data["task"]}]
    for step in data["steps"]:
        messages.append({"role": "assistant", "content": step["content"]})
        if step["tool_calls"]:
            tool_uses = [b for b in step["content"] if b.get("type") == "tool_use"]
            results = [
                {"type": "tool_result",
                 "tool_use_id": tool_uses[tc["call_idx"]]["id"],
                 "content": tc["output"]}
                for tc in step["tool_calls"]
            ]
            messages.append({"role": "user", "content": results})
    return messages


def get_run(run_id: str) -> dict:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            raise KeyError(f"run not found: {run_id}")
        run = dict(row)
        steps = [dict(r) for r in conn.execute(
            "SELECT * FROM steps WHERE run_id=? ORDER BY step_idx", (run_id,)
        ).fetchall()]
        for s in steps:
            s["content"] = json.loads(s["content"])
            s["tool_calls"] = [dict(r) for r in conn.execute(
                "SELECT * FROM tool_calls WHERE run_id=? AND step_idx=? ORDER BY call_idx",
                (run_id, s["step_idx"]),
            ).fetchall()]
            for tc in s["tool_calls"]:
                tc["input"] = json.loads(tc["input"])
        run["steps"] = steps
    return run
