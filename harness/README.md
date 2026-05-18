# harness — minimal LLM agent (Phase 1 MVP)

**Agent = Model + Harness.**
Three parts: `loop.py` (the sacred loop), `tools/` (everything that does work), `store.py` (SQLite truth store).
Nothing else.

## Structure

```
harness/
├── loop.py           # main loop, ≤50 lines, never changes
├── store.py          # SQLite: runs / steps / tool_calls
├── llm.py            # thin Anthropic SDK wrapper
├── tools/
│   ├── __init__.py   # Tool base class + auto-scan registry
│   ├── memory.py     # search_memory, read_memory, write_memory → gbrain
│   ├── bash.py       # bash
│   ├── human.py      # ask_human
│   └── web.py        # web_fetch (Phase 2 stub)
├── prompts/
│   └── system.md     # system prompt
└── cli.py            # entry point
```

## Setup

```bash
cd harness
pip install -r requirements.txt
cp .env.example .env
# fill in ANTHROPIC_API_KEY and GBRAIN_OTP
```

**GBRAIN_OTP** is the 30-second TOTP generated from `GBRAIN_TOTP_SECRET`.
Generate one before each run:

```bash
export GBRAIN_OTP=$(python3 -c "
import pyotp, os
print(pyotp.TOTP(os.environ['GBRAIN_TOTP_SECRET']).now())
")
```

Or add `pyotp` to requirements and generate it inside the tool on each call
(Phase 2 improvement — for now, set it in the shell before running).

## Run a task

```bash
cd harness
python cli.py "Search gbrain for notes about harness, compile a summary, write it to mem/harness-summary"
```

Or from the parent directory:

```bash
python -m harness "your task here"
```

## Demo task (smoke test)

```bash
python cli.py "Search gbrain for any notes about LLM harness or agent loop, then write a one-paragraph summary to mem/harness-overview with title 'LLM Harness Overview'"
```

Expected flow:
1. Agent calls `search_memory(q="LLM harness agent loop")`
2. Reads relevant pages with `read_memory`
3. Calls `write_memory(slug="mem/harness-overview", title="LLM Harness Overview", body="...")`
4. Returns a confirmation message

## Inspect a stored run

Every run is logged to `~/.gbrain/harness.db`.

```bash
# List recent runs
python3 -c "
import sqlite3, json
conn = sqlite3.connect('/root/.gbrain/harness.db')  # adjust path
for row in conn.execute('SELECT id, status, task, started_at FROM runs ORDER BY started_at DESC LIMIT 10'):
    print(dict(zip(['id','status','task','started_at'], row)))
"

# Full replay of a run
python cli.py show <run_id>
```

`get_run(run_id)` returns the full reconstructed run:

```json
{
  "id": "d37bb3e7",
  "task": "...",
  "status": "done",
  "started_at": "...",
  "total_input_tokens": 1240,
  "total_output_tokens": 380,
  "steps": [
    {
      "step_idx": 0,
      "stop_reason": "tool_use",
      "input_tokens": 800,
      "output_tokens": 120,
      "content": [...],
      "tool_calls": [
        {
          "name": "search_memory",
          "input": {"q": "LLM harness"},
          "output": "slug: mem/foo\ntitle: Foo\n..."
        }
      ]
    }
  ]
}
```

## Change a tool without touching the loop

To swap `search_memory` for a different backend, edit only `tools/memory.py`.
The loop has zero knowledge of tool names — it dispatches by `block.name` into
the registry dict, nothing else.

## Smoke test (no API keys needed)

```bash
cd harness
python3 -c "
import sys; sys.path.insert(0, '.')
from tools import load_tools
from tools.bash import Bash
tools = load_tools()
print('tools:', sorted(tools.keys()))
print(Bash().execute(cmd='echo works'))
"
```
