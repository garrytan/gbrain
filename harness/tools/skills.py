"""S05 Skills Injection — contract-backed implementation.

Contracts: openspec/contracts/skills_load_contract.py
           openspec/contracts/skills_list_contract.py
Source of truth: openspec/changes/s05-skills-injection/specs/skills/*.spec.md
DO NOT add logic here that contradicts the spec.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path
from tools import Tool

# Contract imports — generated from spec, never edited by hand.
_CONTRACT_DIR = Path(__file__).parent.parent / "openspec" / "contracts"
sys.path.insert(0, str(_CONTRACT_DIR))

from skills_load_contract import (  # type: ignore
    validate_skill_load_input,
    build_skill_load_success,
    build_skill_load_error,
)
from skills_list_contract import (  # type: ignore
    validate_skill_list_input,
    build_skill_list_success,
    build_skill_list_error,
)

_SKILLS_DIR = Path(__file__).parent.parent / "skills"
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_KEYWORDS_RE = re.compile(r"^keywords:\s*(.+)$", re.MULTILINE)


# ── Pure functions (no I/O, fully testable) ───────────────────────────────────

def _parse_skill(path: Path) -> dict:
    """Parse a skill Markdown file into {name, keywords, body}."""
    text = path.read_text()
    m = _FRONTMATTER_RE.match(text)
    keywords: list[str] = []
    if m:
        km = _KEYWORDS_RE.search(m.group(1))
        if km:
            keywords = [k.strip() for k in km.group(1).split(",")]
    body = _FRONTMATTER_RE.sub("", text).strip()
    return {"name": path.stem, "keywords": keywords, "body": body}


def _load_skills(skills_dir: Path) -> list[dict]:
    """Load all skill files from the given directory."""
    if not skills_dir.exists():
        return []
    return [_parse_skill(p) for p in sorted(skills_dir.glob("*.md"))]


def _matches(query: str, skill: dict) -> bool:
    """Word-boundary match — prevents 'decode' matching keyword 'code'."""
    q = query.lower()
    return any(
        re.search(r"\b" + re.escape(kw) + r"\b", q)
        for kw in skill["keywords"]
    )


def _format_skill_content(skills: list[dict]) -> str:
    """Concatenate skill bodies with separator."""
    return "\n\n---\n\n".join(
        f"## Skill: {s['name']}\n\n{s['body']}" for s in skills
    )


# ── Tool implementations (I/O boundary) ──────────────────────────────────────

class SkillLoad(Tool):
    name = "skill_load"
    description = (
        "Load relevant skill docs for the current task. "
        "Pass the task description; returns matching skill content. "
        "Call at the start of a new task to get domain-specific guidance."
    )
    schema = {
        "name": "skill_load",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Task description or keywords"},
            },
            "required": ["query"],
        },
    }

    def execute(self, **raw) -> str:
        # Contract: validate all external input before processing.
        try:
            inp = validate_skill_load_input(raw)
        except ValueError as e:
            return build_skill_load_error("EMPTY_QUERY", str(e))["message"]

        if not _SKILLS_DIR.exists():
            return build_skill_load_error(
                "SKILLS_DIR_MISSING", f"skills directory not found: {_SKILLS_DIR}"
            )["message"]

        all_skills = _load_skills(_SKILLS_DIR)
        matched = [s for s in all_skills if _matches(inp["query"], s)]
        result = build_skill_load_success(
            matched=len(matched),
            content=_format_skill_content(matched),
        )
        if result["matched"] == 0:
            return "No matching skills found."
        return result["content"]


class SkillList(Tool):
    name = "skill_list"
    description = "List all available skills with their keywords."
    schema = {
        "name": "skill_list",
        "description": description,
        "input_schema": {"type": "object", "properties": {}, "required": []},
    }

    def execute(self, **raw) -> str:
        # Contract: validate (rejects unknown fields per spec).
        try:
            validate_skill_list_input(raw)
        except ValueError as e:
            return build_skill_list_error("SKILLS_DIR_MISSING", str(e))["message"]

        if not _SKILLS_DIR.exists():
            return build_skill_list_error(
                "SKILLS_DIR_MISSING", f"skills directory not found: {_SKILLS_DIR}"
            )["message"]

        skills = _load_skills(_SKILLS_DIR)
        result = build_skill_list_success(skills)
        if result["count"] == 0:
            return "No skills available."
        lines = [f"- {s['name']}: {', '.join(s['keywords'])}" for s in result["skills"]]
        return "\n".join(lines)
