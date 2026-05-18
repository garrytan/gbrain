import threading
from tools import Tool

_depth = threading.local()


class SpawnAgent(Tool):
    name = "spawn_agent"
    description = (
        "Spawn a sub-agent to handle a focused subtask in isolation. "
        "The sub-agent has its own loop, tools, and store entry. Returns its final answer."
    )
    schema = {
        "name": "spawn_agent",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "task":      {"type": "string",  "description": "Subtask for the sub-agent"},
                "max_steps": {"type": "integer", "description": "Step cap (default: 20)"},
            },
            "required": ["task"],
        },
    }

    def execute(self, task: str, max_steps: int = 20) -> str:
        depth = getattr(_depth, "n", 0)
        if depth >= 3:
            return "ERROR: spawn_agent nesting limit (3) reached"
        _depth.n = depth + 1
        try:
            import loop  # lazy — avoids circular import at module load
            return loop.run(task, max_steps=max_steps)
        finally:
            _depth.n = depth
