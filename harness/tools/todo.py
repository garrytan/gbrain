import threading
import store
from tools import Tool

# run_id for the current execution — set by loop.py before tools are invoked.
_ctx = threading.local()


def set_run_id(run_id: str):
    _ctx.run_id = run_id


def _run_id() -> str:
    rid = getattr(_ctx, "run_id", None)
    if not rid:
        raise RuntimeError("todo tool used outside of a run context")
    return rid


def _fmt(todos: list[dict]) -> str:
    if not todos:
        return "No todos."
    lines = [f"[{t['idx']}] [{t['status']}] {t['content']}" for t in todos]
    return "\n".join(lines)


class TodoWrite(Tool):
    name = "todo_write"
    description = (
        "Replace the current plan with a new ordered list of todos. "
        "Call this FIRST before taking any action on a multi-step task. "
        "Each item is a short imperative sentence. Returns the saved list."
    )
    schema = {
        "name": "todo_write",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Ordered list of todo items (imperative sentences)",
                },
            },
            "required": ["items"],
        },
    }

    def execute(self, items: list) -> str:
        if not items:
            return "ERROR: items must be non-empty"
        run_id = _run_id()
        store.set_todos(run_id, [str(i) for i in items])
        return "Plan saved:\n" + _fmt(store.get_todos(run_id))


class TodoRead(Tool):
    name = "todo_read"
    description = "Read the current plan (list of todos with status)."
    schema = {
        "name": "todo_read",
        "description": description,
        "input_schema": {"type": "object", "properties": {}, "required": []},
    }

    def execute(self, **_) -> str:
        return _fmt(store.get_todos(_run_id()))


class TodoUpdate(Tool):
    name = "todo_update"
    description = (
        "Update the status of a todo item. "
        "status: 'in_progress' | 'done' | 'cancelled' | 'pending'"
    )
    schema = {
        "name": "todo_update",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "idx":    {"type": "integer", "description": "Todo index (from todo_read)"},
                "status": {"type": "string",  "description": "New status"},
            },
            "required": ["idx", "status"],
        },
    }

    def execute(self, idx: int, status: str) -> str:
        store.update_todo(_run_id(), idx, status)
        return _fmt(store.get_todos(_run_id()))
