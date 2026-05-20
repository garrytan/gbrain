from __future__ import annotations
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import store, llm
from tools import load_tools
from tools import todo as _todo_mod
from pathlib import Path

# Cache system prompt and tool registry — both are static for the process lifetime.
_system_prompt = None  # str | None
_tools = None


def _get_system_prompt() -> str:
    global _system_prompt
    if _system_prompt is None:
        _system_prompt = (Path(__file__).parent / "prompts/system.md").read_text()
    return _system_prompt


def _get_tools():
    global _tools
    if _tools is None:
        _tools = load_tools()
    return _tools


def extract_text(response) -> str:
    for block in response.content:
        if hasattr(block, "text"):
            return block.text
    return ""


def _run_tool(tools, block):
    """Execute one tool and return (block, output, latency_ms)."""
    t = time.monotonic()
    tool = tools.get(block.name)
    if tool is None:
        return block, f"ERROR: unknown tool '{block.name}'", int((time.monotonic() - t) * 1000)
    try:
        output = tool.execute(**block.input)
    except Exception as e:
        output = f"ERROR: {type(e).__name__}: {e}"
    return block, output, int((time.monotonic() - t) * 1000)


def run(task: str, max_steps: int = 50) -> str:
    tools = _get_tools()
    system = _get_system_prompt()
    run_id = store.create_run(task)
    _todo_mod.set_run_id(run_id)
    messages = [{"role": "user", "content": task}]
    ms = lambda t: int((time.monotonic() - t) * 1000)

    for step in range(max_steps):
        t0 = time.monotonic()
        response = llm.complete(
            messages=messages,
            tools=[t.schema for t in tools.values()],
            system=system,
        )
        messages.append({"role": "assistant", "content": response.content})
        store.log_step(run_id, step, response, ms(t0))

        if response.stop_reason != "tool_use":
            store.finish_run(run_id, "done")
            return extract_text(response)

        tool_blocks = [b for b in response.content if b.type == "tool_use"]
        timings: dict = {}
        outputs: dict = {}

        # Run all tool calls in parallel (I/O-bound: web, memory, etc.).
        with ThreadPoolExecutor(max_workers=len(tool_blocks) or 1) as ex:
            futs = {ex.submit(_run_tool, tools, b): b for b in tool_blocks}
            for fut in as_completed(futs):
                block, output, tool_ms = fut.result()
                outputs[block.id] = output
                timings[block.id] = tool_ms

        results = []
        for block in tool_blocks:
            output = outputs[block.id]
            store.log_tool_call(run_id, step, block.name, block.input, output, timings[block.id])
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": output})
        messages.append({"role": "user", "content": results})

    store.finish_run(run_id, "step_limit_exceeded")
    raise RuntimeError(f"Step limit {max_steps} exceeded")
