"""
Filesystem Context Manager -- composable utilities for filesystem-based context engineering.

Provides three core patterns for managing agent context through the filesystem:
1. ScratchPadManager -- offload large tool outputs to files, return compact references
2. AgentPlan / PlanStep -- persist plans to disk so agents survive context window refreshes
3. ToolOutputHandler -- automatic offload-or-inline decision for tool outputs

Use when:
    - Tool outputs exceed ~2000 tokens and would bloat the context window
    - Agents need plan persistence across long-horizon, multi-turn tasks
    - Building agent systems that offload intermediate results to files

Example (library usage)::

    from filesystem_context import ScratchPadManager, ToolOutputHandler

    handler = ToolOutputHandler(ScratchPadManager(base_path="scratch"))
    result = handler.process_output("web_search", large_output_string)

Example (CLI demo)::

    python filesystem_context.py
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

__all__: list[str] = [
    "ScratchPadManager",
    "PlanStep",
    "AgentPlan",
    "ToolOutputHandler",
]


# =============================================================================
# Pattern 1: Scratch Pad Manager
# =============================================================================


class ScratchPadManager:
    """Manage temporary file storage for offloading large tool outputs.

    Use when: tool outputs exceed a token threshold and would bloat the
    context window. Writes content to a scratch directory and returns a
    compact reference the agent can include in context instead.
    """

    def __init__(self, base_path: str = "scratch", token_threshold: int = 2000) -> None:
        self.base_path: Path = Path(base_path)
        self.base_path.mkdir(parents=True, exist_ok=True)
        self.token_threshold: int = token_threshold

    def estimate_tokens(self, content: str) -> int:
        """Return a rough token estimate (~4 characters per token).

        Use when: deciding whether content should be offloaded before
        writing it to disk.
        """
        return len(content) // 4

    def should_offload(self, content: str) -> bool:
        """Return True if *content* exceeds the configured token threshold.

        Use when: making an inline-vs-offload decision for a tool output.
        """
        return self.estimate_tokens(content) > self.token_threshold

    def offload(self, content: str, source: str) -> Dict[str, Any]:
        """Write *content* to a timestamped scratch file and return a reference dict.

        Use when: a tool output has been determined to exceed the threshold
        and should be persisted to disk.

        Returns a dict with keys: path, source, tokens_saved, summary.
        """
        timestamp: str = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        filename: str = f"{source}_{timestamp}.txt"
        file_path: Path = self.base_path / filename

        file_path.write_text(content)

        # Extract summary from first meaningful lines
        lines: list[str] = content.strip().split("\n")[:5]
        summary: str = "\n".join(lines)
        if len(summary) > 300:
            summary = summary[:300] + "..."

        return {
            "path": str(file_path),
            "source": source,
            "tokens_saved": self.estimate_tokens(content),
            "summary": summary,
        }

    def format_reference(self, ref: Dict[str, Any]) -> str:
        """Format a reference dict as a compact string for context inclusion.

        Use when: constructing the replacement message that goes into context
        in place of the full tool output.
        """
        return (
            f"[Output from {ref['source']} saved to {ref['path']}. "
            f"~{ref['tokens_saved']} tokens. "
            f"Summary: {ref['summary'][:200]}]"
        )

    def cleanup(self, max_age_seconds: int = 3600) -> int:
        """Remove scratch files older than *max_age_seconds*.

        Use when: ending a session or when the scratch directory has grown
        large enough to slow directory listings.

        Returns the number of files removed.
        """
        removed: int = 0
        now: float = datetime.now().timestamp()
        for f in self.base_path.iterdir():
            if f.is_file() and (now - f.stat().st_mtime) > max_age_seconds:
                f.unlink()
                removed += 1
        return removed


# =============================================================================
# Pattern 2: Plan Persistence
# =============================================================================


@dataclass
class PlanStep:
    """Individual step in an agent plan.

    Use when: building a plan that will be persisted to disk for later
    re-reading across context window boundaries.
    """

    id: int
    description: str
    status: str = "pending"  # pending | in_progress | completed | blocked
    notes: Optional[str] = None


@dataclass
class AgentPlan:
    """Persistent plan that survives context window limitations.

    Use when: an agent needs to track a multi-step objective across turns
    or context refreshes. Write the plan to disk so the agent can re-read
    it at any point, even after summarization or context window refresh.
    """

    objective: str
    steps: List[PlanStep] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the plan to a plain dict suitable for JSON output."""
        return {
            "objective": self.objective,
            "created_at": self.created_at,
            "steps": [
                {
                    "id": s.id,
                    "description": s.description,
                    "status": s.status,
                    "notes": s.notes,
                }
                for s in self.steps
            ],
        }

    def save(self, path: str = "scratch/current_plan.json") -> None:
        """Persist plan to *path* as JSON.

        Use when: a plan has been created or updated and must survive a
        potential context refresh.
        """
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(self.to_dict(), f, indent=2)
        print(f"Plan saved to {path}")

    @classmethod
    def load(cls, path: str = "scratch/current_plan.json") -> AgentPlan:
        """Load a plan from *path*.

        Use when: resuming work in a new context window or after
        summarization -- re-read the plan to restore task awareness.
        """
        with open(path, "r") as f:
            data: Dict[str, Any] = json.load(f)

        plan = cls(objective=data["objective"])
        plan.created_at = data.get("created_at", "")

        for step_data in data.get("steps", []):
            plan.steps.append(
                PlanStep(
                    id=step_data["id"],
                    description=step_data["description"],
                    status=step_data["status"],
                    notes=step_data.get("notes"),
                )
            )
        return plan

    def current_step(self) -> Optional[PlanStep]:
        """Return the first non-completed step, or None if all are done.

        Use when: determining what to work on next after re-reading a plan.
        """
        for step in self.steps:
            if step.status not in ("completed", "cancelled"):
                return step
        return None

    def complete_step(self, step_id: int, notes: Optional[str] = None) -> None:
        """Mark step *step_id* as completed, optionally attaching *notes*.

        Use when: an agent finishes a plan step and needs to record
        progress before persisting the updated plan.
        """
        for step in self.steps:
            if step.id == step_id:
                step.status = "completed"
                if notes:
                    step.notes = notes
                return
        raise ValueError(f"Step {step_id} not found")

    def progress_summary(self) -> str:
        """Generate a compact progress string for context injection.

        Use when: the agent needs a one-line status to include in context
        without re-reading the full plan.
        """
        completed: int = sum(1 for s in self.steps if s.status == "completed")
        total: int = len(self.steps)
        current: Optional[PlanStep] = self.current_step()

        summary: str = f"Objective: {self.objective}\n"
        summary += f"Progress: {completed}/{total} steps completed\n"
        if current:
            summary += f"Current step: [{current.id}] {current.description}"
        else:
            summary += "All steps completed."

        return summary


# =============================================================================
# Pattern 3: Tool Output Handler
# =============================================================================


class ToolOutputHandler:
    """Automatically decide whether to inline or offload tool outputs.

    Use when: building an agent loop that processes heterogeneous tool
    outputs -- some small enough to inline, others requiring offload.
    """

    def __init__(self, scratch_pad: Optional[ScratchPadManager] = None) -> None:
        self.scratch_pad: ScratchPadManager = scratch_pad or ScratchPadManager()

    def process_output(self, tool_name: str, output: str) -> str:
        """Return *output* directly if small, or a file reference if large.

        Use when: handling a tool's return value in an agent loop. Pass
        the result into context; offloading happens transparently.
        """
        if self.scratch_pad.should_offload(output):
            ref: Dict[str, Any] = self.scratch_pad.offload(output, source=tool_name)
            return self.scratch_pad.format_reference(ref)
        return output


# =============================================================================
# Demonstration
# =============================================================================


def _demo_scratch_pad() -> None:
    """Demonstrate the scratch pad offloading pattern."""
    print("=" * 60)
    print("DEMO: Scratch Pad for Tool Output Offloading")
    print("=" * 60)

    scratch = ScratchPadManager(base_path="demo_scratch", token_threshold=100)

    # Small output stays in context
    small_output: str = "API returned: {'status': 'ok', 'data': [1, 2, 3]}"
    print(f"\nSmall output ({scratch.estimate_tokens(small_output)} tokens):")
    print(f"  Should offload: {scratch.should_offload(small_output)}")

    # Large output gets offloaded
    large_output: str = """
Search Results for "context engineering":

1. Context Engineering: The Art of Curating LLM Context
   URL: https://example.com/article1
   Snippet: Context engineering is the discipline of managing what information
   enters the language model's context window. Unlike prompt engineering which
   focuses on instruction crafting, context engineering addresses the holistic
   curation of all information...

2. Building Production Agents with Effective Context Management
   URL: https://example.com/article2
   Snippet: Production agent systems require sophisticated context management
   strategies. This includes compression, caching, and strategic partitioning
   of work across sub-agents with isolated contexts...

3. The Lost-in-Middle Problem and How to Avoid It
   URL: https://example.com/article3
   Snippet: Research shows that language models exhibit U-shaped attention
   patterns, with information in the middle of long contexts receiving less
   attention than content at the beginning or end...

... (imagine 50 more results) ...
"""

    print(f"\nLarge output ({scratch.estimate_tokens(large_output)} tokens):")
    print(f"  Should offload: {scratch.should_offload(large_output)}")

    if scratch.should_offload(large_output):
        ref = scratch.offload(large_output, source="web_search")
        print(f"\nOffloaded to: {ref['path']}")
        print(f"Tokens saved: {ref['tokens_saved']}")
        print(f"\nReference for context:\n{scratch.format_reference(ref)}")


def _demo_plan_persistence() -> None:
    """Demonstrate the plan persistence pattern."""
    print("\n" + "=" * 60)
    print("DEMO: Plan Persistence for Long-Horizon Tasks")
    print("=" * 60)

    plan = AgentPlan(objective="Refactor authentication module")
    plan.steps = [
        PlanStep(id=1, description="Audit current auth endpoints"),
        PlanStep(id=2, description="Design new token validation flow"),
        PlanStep(id=3, description="Implement changes"),
        PlanStep(id=4, description="Write tests"),
        PlanStep(id=5, description="Deploy and monitor"),
    ]

    print("\nInitial plan:")
    print(plan.progress_summary())

    plan.save("demo_scratch/current_plan.json")

    # Simulate completing first step
    plan.complete_step(1, notes="Found 12 endpoints, 3 need updates")
    plan.steps[1].status = "in_progress"

    print("\nAfter completing step 1:")
    print(plan.progress_summary())

    plan.save("demo_scratch/current_plan.json")

    # Simulate loading from file (as if in new context)
    print("\n--- Simulating context refresh ---")
    loaded_plan = AgentPlan.load("demo_scratch/current_plan.json")
    print("\nPlan loaded from file:")
    print(loaded_plan.progress_summary())


def _demo_tool_handler() -> None:
    """Demonstrate the integrated tool output handler."""
    print("\n" + "=" * 60)
    print("DEMO: Integrated Tool Output Handler")
    print("=" * 60)

    handler = ToolOutputHandler(
        scratch_pad=ScratchPadManager(base_path="demo_scratch", token_threshold=50)
    )

    outputs: list[tuple[str, str]] = [
        ("calculator", "42"),
        ("file_read", "Error: File not found"),
        (
            "database_query",
            """
            Results (250 rows):
            | id | name | email | created_at | status |
            |----|------|-------|------------|--------|
            | 1  | John | j@e.c | 2024-01-01 | active |
            | 2  | Jane | j@e.c | 2024-01-02 | active |
            ... (248 more rows) ...
        """,
        ),
    ]

    for tool_name, output in outputs:
        processed: str = handler.process_output(tool_name, output)
        print(f"\n{tool_name}:")
        print(f"  Original length: {len(output)} chars")
        print(f"  Processed: {processed[:100]}...")


def _cleanup_demo() -> None:
    """Remove demo files created during the demonstration."""
    demo_path = Path("demo_scratch")
    if demo_path.exists():
        shutil.rmtree(demo_path)
        print("\nDemo files cleaned up.")


if __name__ == "__main__":
    _demo_scratch_pad()
    _demo_plan_persistence()
    _demo_tool_handler()

    print("\n" + "=" * 60)
    print("Cleaning up demo files...")
    _cleanup_demo()
