"""S07 Task System — file-backed tasks with dependency graph."""
from __future__ import annotations
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from tools import Tool

_TASKS_DIR = Path(__file__).parent.parent / "tasks"
_TASKS_DIR.mkdir(exist_ok=True)

_STATUSES = {"pending", "in_progress", "done", "cancelled", "blocked"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _task_path(task_id: str) -> Path:
    return _TASKS_DIR / f"{task_id}.json"


def _load(task_id: str) -> dict:
    p = _task_path(task_id)
    if not p.exists():
        raise KeyError(f"task not found: {task_id}")
    return json.loads(p.read_text())


def _save(task: dict) -> None:
    _task_path(task["id"]).write_text(json.dumps(task, indent=2))


def _all_tasks() -> list[dict]:
    tasks = []
    for p in sorted(_TASKS_DIR.glob("*.json")):
        try:
            tasks.append(json.loads(p.read_text()))
        except Exception:
            pass
    return tasks


def _blocked_by(task: dict, all_tasks: list[dict]) -> list[str]:
    """Return IDs of dependencies that are not yet done."""
    done_ids = {t["id"] for t in all_tasks if t["status"] == "done"}
    return [dep for dep in task.get("depends_on", []) if dep not in done_ids]


def _fmt_task(t: dict, blockers: list[str] | None = None) -> str:
    parts = [f"[{t['id']}] [{t['status']}] {t['title']}"]
    if t.get("description"):
        parts.append(f"  {t['description']}")
    if t.get("depends_on"):
        parts.append(f"  depends_on: {', '.join(t['depends_on'])}")
    if blockers:
        parts.append(f"  BLOCKED by: {', '.join(blockers)}")
    if t.get("assigned_to"):
        parts.append(f"  assigned_to: {t['assigned_to']}")
    return "\n".join(parts)


class TaskCreate(Tool):
    name = "task_create"
    description = (
        "Create a new task with optional dependencies and assignee. "
        "Returns the new task ID. Use for long-running or cross-run work."
    )
    schema = {
        "name": "task_create",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "title":       {"type": "string", "description": "Short task title"},
                "description": {"type": "string", "description": "Detailed description"},
                "depends_on":  {"type": "array", "items": {"type": "string"},
                                "description": "Task IDs that must be done first"},
                "assigned_to": {"type": "string", "description": "Agent or person name"},
            },
            "required": ["title"],
        },
    }

    def execute(self, title: str, description: str = "", depends_on: list = None,
                assigned_to: str = "") -> str:
        task = {
            "id": uuid.uuid4().hex[:8],
            "title": title,
            "description": description,
            "status": "pending",
            "depends_on": depends_on or [],
            "assigned_to": assigned_to,
            "created_at": _now(),
            "updated_at": _now(),
        }
        _save(task)
        return f"Created: {_fmt_task(task)}"


class TaskList(Tool):
    name = "task_list"
    description = "List all tasks, optionally filtered by status."
    schema = {
        "name": "task_list",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string",
                           "description": "Filter by status (pending/in_progress/done/cancelled/blocked). Omit for all."},
            },
            "required": [],
        },
    }

    def execute(self, status: str = "", **_) -> str:
        all_tasks = _all_tasks()
        tasks = [t for t in all_tasks if t["status"] == status] if status else all_tasks
        if not tasks:
            return "No tasks."
        lines = [_fmt_task(t, _blocked_by(t, all_tasks) or None) for t in tasks]
        return "\n\n".join(lines)


class TaskUpdate(Tool):
    name = "task_update"
    description = "Update a task's status and/or assigned_to."
    schema = {
        "name": "task_update",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "id":          {"type": "string", "description": "Task ID"},
                "status":      {"type": "string", "description": "New status"},
                "assigned_to": {"type": "string", "description": "New assignee"},
            },
            "required": ["id"],
        },
    }

    def execute(self, id: str, status: str = "", assigned_to: str = "") -> str:
        task = _load(id)
        if status:
            if status not in _STATUSES:
                return f"ERROR: status must be one of {sorted(_STATUSES)}"
            if status == "in_progress":
                blockers = _blocked_by(task, _all_tasks())
                if blockers:
                    return f"ERROR: cannot start, blocked by: {', '.join(blockers)}"
            task = {**task, "status": status, "updated_at": _now()}
        if assigned_to:
            task = {**task, "assigned_to": assigned_to, "updated_at": _now()}
        _save(task)
        return _fmt_task(task)


class TaskDelete(Tool):
    name = "task_delete"
    description = "Delete a task file permanently. Use only for tasks that are no longer relevant."
    schema = {
        "name": "task_delete",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Task ID to delete"},
            },
            "required": ["id"],
        },
    }

    def execute(self, id: str) -> str:
        p = _task_path(id)
        if not p.exists():
            return f"ERROR: task not found: {id}"
        p.unlink()
        return f"Deleted task {id}"


class TaskGet(Tool):
    name = "task_get"
    description = "Get full details of a task by ID."
    schema = {
        "name": "task_get",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Task ID"},
            },
            "required": ["id"],
        },
    }

    def execute(self, id: str) -> str:
        task = _load(id)
        blockers = _blocked_by(task, _all_tasks())
        return _fmt_task(task, blockers if blockers else None)
