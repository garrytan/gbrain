import re
from pathlib import Path
from tools import Tool

_SKILLS_DIR = Path(__file__).parent.parent / "skills"
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_KEYWORDS_RE = re.compile(r"^keywords:\s*(.+)$", re.MULTILINE)


def _load_skills() -> list[dict]:
    skills = []
    for path in sorted(_SKILLS_DIR.glob("*.md")):
        text = path.read_text()
        m = _FRONTMATTER_RE.match(text)
        keywords = []
        if m:
            km = _KEYWORDS_RE.search(m.group(1))
            if km:
                keywords = [k.strip() for k in km.group(1).split(",")]
        body = _FRONTMATTER_RE.sub("", text).strip()
        skills.append({"name": path.stem, "keywords": keywords, "body": body})
    return skills


def _match(query: str, skill: dict) -> bool:
    q = query.lower()
    return any(re.search(r"\b" + re.escape(kw) + r"\b", q) for kw in skill["keywords"])


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

    def execute(self, query: str) -> str:
        skills = _load_skills()
        matched = [s for s in skills if _match(query, s)]
        if not matched:
            return "No matching skills found."
        parts = []
        for s in matched:
            parts.append(f"## Skill: {s['name']}\n\n{s['body']}")
        return "\n\n---\n\n".join(parts)


class SkillList(Tool):
    name = "skill_list"
    description = "List all available skills with their keywords."
    schema = {
        "name": "skill_list",
        "description": description,
        "input_schema": {"type": "object", "properties": {}, "required": []},
    }

    def execute(self, **_) -> str:
        skills = _load_skills()
        if not skills:
            return "No skills available."
        lines = [f"- {s['name']}: {', '.join(s['keywords'])}" for s in skills]
        return "\n".join(lines)
