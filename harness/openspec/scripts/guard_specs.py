#!/usr/bin/env python3
"""guard:specs — validate all spec files match the military-grade spec format."""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

_REQUIRED_FM_KEYS = {"domain", "action", "version"}
_REQUIRED_SECTIONS = {"## input", "## success", "## error", "## examples"}
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_SECTION_RE = re.compile(r"^(## \w+)", re.MULTILINE)
_JSON_BLOCK_RE = re.compile(r"```json\s*(.*?)```", re.DOTALL)
_EXAMPLE_NAME_RE = re.compile(r"^### (valid-|invalid-)[\w-]+$", re.MULTILINE)

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"


def _parse_simple_yaml(text: str) -> dict:
    """Minimal YAML parser for flat key: value frontmatter."""
    result = {}
    for line in text.strip().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            result[k.strip()] = v.strip()
    return result


def guard_spec(path: Path) -> list[str]:
    """Return list of error strings; empty = passed."""
    errors = []
    text = path.read_text()

    # 1. frontmatter
    fm_match = _FRONTMATTER_RE.match(text)
    if not fm_match:
        return [f"missing frontmatter block"]
    fm = _parse_simple_yaml(fm_match.group(1))
    for key in _REQUIRED_FM_KEYS:
        if key not in fm:
            errors.append(f"missing frontmatter key: {key}")
    if "version" in fm:
        try:
            assert int(fm["version"]) >= 1
        except (ValueError, AssertionError):
            errors.append(f"frontmatter version must be integer >= 1, got: {fm['version']!r}")

    # 2. required sections present
    body = text[fm_match.end():]
    found_sections = set(re.findall(r"^## \w+", body, re.MULTILINE))
    for sec in _REQUIRED_SECTIONS:
        if sec not in found_sections:
            errors.append(f"missing section: {sec}")

    # 3. each required section has at least one ```json block
    sections = re.split(r"(?=^## )", body, flags=re.MULTILINE)
    sec_map = {}
    for chunk in sections:
        header_m = re.match(r"^(## \w+)", chunk)
        if header_m:
            sec_map[header_m.group(1)] = chunk

    for sec in ("## input", "## success", "## error"):
        if sec in sec_map:
            json_blocks = _JSON_BLOCK_RE.findall(sec_map[sec])
            if not json_blocks:
                errors.append(f"section {sec} has no ```json block")
            else:
                for raw in json_blocks:
                    try:
                        json.loads(raw.strip()) if raw.strip() != "{}" else {}
                        # Allow schema-description strings as valid (non-strict JSON)
                    except json.JSONDecodeError:
                        # Schema descriptions use "string (required)" — not strict JSON
                        # Only flag if it's not a schema description
                        if not re.search(r'"\w+\s*\(', raw):
                            errors.append(f"invalid JSON in {sec}")

    # 4. ## examples: at least one valid- and one invalid- case
    if "## examples" in sec_map:
        example_body = sec_map["## examples"]
        valid_count = len(re.findall(r"^### valid-", example_body, re.MULTILINE))
        invalid_count = len(re.findall(r"^### invalid-", example_body, re.MULTILINE))
        all_names = re.findall(r"^### ([\w-]+)", example_body, re.MULTILINE)
        for name in all_names:
            if not (name.startswith("valid-") or name.startswith("invalid-")):
                errors.append(f"example name must start with valid- or invalid-: {name!r}")
        if valid_count == 0:
            errors.append("## examples must have at least one valid- case")
        if invalid_count == 0:
            errors.append("## examples must have at least one invalid- case")
        # each example must have a ```json block
        example_chunks = re.split(r"(?=^### )", example_body, flags=re.MULTILINE)
        for chunk in example_chunks:
            name_m = re.match(r"^### ([\w-]+)", chunk)
            if name_m and not _JSON_BLOCK_RE.search(chunk):
                errors.append(f"example {name_m.group(1)!r} has no ```json block")

    return errors


def main():
    spec_root = Path(__file__).parent.parent / "changes"
    specs = sorted(spec_root.rglob("*.spec.md"))
    if not specs:
        print("No spec files found.")
        sys.exit(1)

    passed = 0
    failed = 0
    for spec in specs:
        rel = spec.relative_to(spec_root.parent.parent)
        errors = guard_spec(spec)
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
