"""inbox.py — check_inbox tool.

Scans wiki/inbox/ for pending tasks assigned to a given agent,
returns a structured list so the agent can pick up work from Genspark.

Contract: openspec/changes/s08-inbox-tool/specs/inbox/check.spec.md
"""
from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "openspec" / "contracts"))

import requests
from tools import Tool
from tools.memory import GBRAIN_BASE, _headers
from inbox_check_contract import (   # type: ignore
    validate_inbox_check_input,
    build_inbox_check_success,
    build_inbox_check_error,
)


def _extract_frontmatter_field(content: str, field: str) -> str:
    """Extract a single field value from YAML frontmatter."""
    for line in content.splitlines():
        if line.startswith(f"{field}:"):
            return line.split(":", 1)[1].strip()
    return ""


def _excerpt(content: str, max_chars: int = 200) -> str:
    """Return the Task section body as a short excerpt."""
    in_task = False
    lines = []
    for line in content.splitlines():
        if line.startswith("## Task"):
            in_task = True
            continue
        if in_task:
            if line.startswith("## "):
                break
            lines.append(line)
    text = " ".join(lines).strip()
    return text[:max_chars] + ("…" if len(text) > max_chars else "")


class CheckInbox(Tool):
    name = "check_inbox"
    description = (
        "Check wiki/inbox/ for pending tasks assigned to this agent. "
        "Returns a list of tasks with slug, title, and excerpt. "
        "Run at the start of each session to pick up work from Genspark."
    )
    schema = {
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "assigned_to": {
                    "type": "string",
                    "description": "Filter by assignee (default: 'local-ai')",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max tasks to return (default: 5, max: 20)",
                },
            },
            "required": [],
        },
    }

    def execute(self, **raw) -> str:
        # Validate input via contract
        try:
            inp = validate_inbox_check_input(raw)
        except ValueError as e:
            result = build_inbox_check_error("INVALID_LIMIT", str(e))
            return f"ERROR [{result['code']}]: {result['message']}"

        assigned_to: str = inp["assigned_to"]
        limit: int = inp["limit"]

        # Search GBrain for wiki/inbox pages with status:pending
        try:
            r = requests.get(
                f"{GBRAIN_BASE}/search",
                params={
                    "lex": f"wiki/inbox status pending assigned_to {assigned_to}",
                    "limit": limit * 2,  # fetch extra to filter
                    "include_pending": "1",
                },
                headers=_headers(),
                timeout=15,
            )
            r.raise_for_status()
        except Exception as e:
            result = build_inbox_check_error("SEARCH_FAILED", str(e))
            return f"ERROR [{result['code']}]: {result['message']}"

        results = r.json().get("results", [])

        tasks = []
        for item in results:
            slug = item.get("slug", "")
            if not slug.startswith("wiki/inbox/"):
                continue

            # Fetch full page to read frontmatter
            try:
                pr = requests.get(
                    f"{GBRAIN_BASE}/page",
                    params={"slug": slug},
                    headers=_headers(),
                    timeout=10,
                )
                if pr.status_code != 200:
                    continue
                page_data = pr.json()
                content = page_data.get("content") or page_data.get("body") or ""
            except Exception:
                continue

            status = _extract_frontmatter_field(content, "status")
            page_assigned = _extract_frontmatter_field(content, "assigned_to")

            if status != "pending":
                continue
            if page_assigned and page_assigned != assigned_to:
                continue

            tasks.append({
                "slug": slug,
                "title": item.get("title") or slug,
                "assigned_to": page_assigned or assigned_to,
                "created_by": _extract_frontmatter_field(content, "created_by"),
                "created": _extract_frontmatter_field(content, "created"),
                "task_excerpt": _excerpt(content),
            })

            if len(tasks) >= limit:
                break

        success = build_inbox_check_success(tasks)

        if success["found"] == 0:
            return "收件匣是空的，沒有待執行的任務。"

        lines = [f"找到 {success['found']} 個待執行任務：\n"]
        for t in success["tasks"]:
            lines.append(f"slug: {t['slug']}")
            lines.append(f"title: {t['title']}")
            lines.append(f"created_by: {t['created_by']} | created: {t['created']}")
            lines.append(f"task: {t['task_excerpt']}")
            lines.append("---")
        return "\n".join(lines)
