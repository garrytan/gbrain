#!/usr/bin/env python3
"""guard:contracts — run all spec examples through their contract validators."""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "contracts"))

from skills_load_contract import validate_skill_load_input    # type: ignore
from skills_list_contract import validate_skill_list_input    # type: ignore

# Map (domain, action) → validator function
_VALIDATORS = {
    ("skills", "load"): validate_skill_load_input,
    ("skills", "list"): validate_skill_list_input,
}

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_JSON_BLOCK_RE = re.compile(r"```json\s*(.*?)```", re.DOTALL)

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"


def _parse_simple_yaml(text: str) -> dict:
    result = {}
    for line in text.strip().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            result[k.strip()] = v.strip()
    return result


def guard_contract(path: Path) -> list[str]:
    errors = []
    text = path.read_text()
    fm_match = _FRONTMATTER_RE.match(text)
    if not fm_match:
        return ["missing frontmatter"]
    fm = _parse_simple_yaml(fm_match.group(1))
    key = (fm.get("domain", ""), fm.get("action", ""))
    validator = _VALIDATORS.get(key)
    if validator is None:
        return [f"no validator for domain={key[0]!r} action={key[1]!r}"]

    body = text[fm_match.end():]
    sections = re.split(r"(?=^## )", body, flags=re.MULTILINE)
    examples_chunk = next((s for s in sections if s.startswith("## examples")), "")
    example_blocks = re.split(r"(?=^### )", examples_chunk, flags=re.MULTILINE)

    for block in example_blocks:
        name_m = re.match(r"^### ([\w-]+)", block)
        if not name_m:
            continue
        name = name_m.group(1)
        json_m = _JSON_BLOCK_RE.search(block)
        if not json_m:
            errors.append(f"example {name!r}: no json block")
            continue
        try:
            data = json.loads(json_m.group(1).strip())
        except json.JSONDecodeError as e:
            errors.append(f"example {name!r}: invalid JSON: {e}")
            continue

        should_pass = name.startswith("valid-")
        try:
            validator(data)
            if not should_pass:
                errors.append(f"example {name!r}: expected validation to FAIL but it PASSED")
        except (ValueError, KeyError, TypeError) as e:
            if should_pass:
                errors.append(f"example {name!r}: expected validation to PASS but got: {e}")

    return errors


def main():
    spec_root = Path(__file__).parent.parent / "changes"
    specs = sorted(spec_root.rglob("*.spec.md"))
    passed = failed = 0
    for spec in specs:
        rel = spec.relative_to(spec_root.parent.parent)
        errors = guard_contract(spec)
        if errors:
            print(f"{FAIL} {rel}")
            for e in errors:
                print(f"     → {e}")
            failed += 1
        else:
            print(f"{PASS} {rel}")
            passed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
