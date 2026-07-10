#!/usr/bin/env python3
"""Regenerate assets/metadata_snapshot.json from the repo-root SSoT.

`.skill` packages ship only the skill folder — not repo-root
skills-index.yaml / workflows/. The Claude Web App therefore needs a
bundled snapshot. This script builds it from the SSoT using the SAME
normalize_* functions recommend.py uses, so the repo-root and snapshot
code paths produce byte-identical recommendations (the parity invariant).

Usage:
  build_snapshot.py [--project-root PATH] [--check]

`--check` exits non-zero if the committed snapshot drifts from the SSoT
(wired into pre-commit + CI, mirroring generate_catalog_from_index.py).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Import the SSoT loader + normalizers from the sibling recommender so the
# snapshot can never diverge from how recommend.py interprets the SSoT.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import json  # noqa: E402

from recommend import (  # noqa: E402
    BUNDLED_SNAPSHOT,
    load_ssot,
)


def build_snapshot_text(project_root: Path) -> str:
    """Return the canonical snapshot JSON text for the given SSoT root."""
    metadata = load_ssot(project_root)
    # Same canonical encoding as recommend.dumps(): sorted keys, 2-space
    # indent, trailing newline (end-of-file-fixer parity).
    return json.dumps(metadata, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Regenerate assets/metadata_snapshot.json from the SSoT."
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path.cwd(),
        help="Repository root holding skills-index.yaml + workflows/ (default: cwd)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the committed snapshot would change.",
    )
    parser.add_argument(
        "--snapshot-path",
        type=Path,
        default=BUNDLED_SNAPSHOT,
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args(argv)

    index_path = args.project_root / "skills-index.yaml"
    workflows_dir = args.project_root / "workflows"
    if not index_path.is_file() or not workflows_dir.is_dir():
        print(
            f"ERROR: SSoT not found under {args.project_root} "
            "(need skills-index.yaml + workflows/)",
            file=sys.stderr,
        )
        return 1

    try:
        regenerated = build_snapshot_text(args.project_root)
    except Exception as exc:  # noqa: BLE001 — surface load/parse errors cleanly
        print(f"ERROR: failed to build snapshot: {exc}", file=sys.stderr)
        return 1

    snap_path: Path = args.snapshot_path
    current = snap_path.read_text(encoding="utf-8") if snap_path.is_file() else None

    if args.check:
        if current != regenerated:
            print(
                f"DRIFT: {snap_path} is out of sync with the SSoT. "
                "Run: python3 skills/trading-skills-navigator/scripts/"
                "build_snapshot.py",
                file=sys.stderr,
            )
            return 1
        print(f"OK: {snap_path} matches the SSoT", file=sys.stderr)
        return 0

    if current == regenerated:
        print(f"Unchanged: {snap_path}", file=sys.stderr)
        return 0
    snap_path.parent.mkdir(parents=True, exist_ok=True)
    snap_path.write_text(regenerated, encoding="utf-8")
    print(f"Wrote {snap_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
