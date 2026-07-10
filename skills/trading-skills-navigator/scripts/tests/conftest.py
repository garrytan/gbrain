"""Shared fixtures for trading-skills-navigator tests.

Minimal `write_index` / `write_workflow` helpers mirror
scripts/tests/test_validate_skills_index.py (duplicated here, not imported —
the repo's per-skill conftest isolation makes cross-skill imports unclean).

The 10-question golden suite runs against the REAL repo SSoT (the executable
Phase-1 DoD); the synthetic helpers are for isolating the credential-aware
--no-api rule.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable

import pytest
import yaml

# Make recommend.py / build_snapshot.py importable (module names are unique;
# the root conftest only evicts known-conflicting basenames).
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCRIPTS_DIR))


def _find_repo_root(start: Path) -> Path:
    for parent in [start, *start.parents]:
        if (parent / "skills-index.yaml").is_file() and (parent / "workflows").is_dir():
            return parent
    raise RuntimeError("could not locate repo root (skills-index.yaml + workflows/)")


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return _find_repo_root(Path(__file__).resolve())


@pytest.fixture(scope="session")
def repo_metadata(repo_root: Path) -> dict[str, Any]:
    """Normalized metadata loaded from the real repo SSoT."""
    from recommend import load_ssot

    return load_ssot(repo_root)


@pytest.fixture(scope="session")
def bundled_metadata() -> dict[str, Any]:
    """Normalized metadata loaded from the committed bundled snapshot."""
    from recommend import BUNDLED_SNAPSHOT, load_snapshot

    return load_snapshot(BUNDLED_SNAPSHOT)


@pytest.fixture()
def write_index(tmp_path: Path) -> Callable[..., Path]:
    """Write a minimal skills-index.yaml into tmp_path; return its dir."""

    def _write(skills: list[dict[str, Any]]) -> Path:
        payload = {
            "schema_version": 1,
            "categories": [
                "market-regime",
                "core-portfolio",
                "swing-opportunity",
                "trade-planning",
                "trade-memory",
                "strategy-research",
                "advanced-satellite",
                "meta",
            ],
            "skills": skills,
        }
        (tmp_path / "skills-index.yaml").write_text(
            yaml.safe_dump(payload, sort_keys=False), encoding="utf-8"
        )
        return tmp_path

    return _write


@pytest.fixture()
def write_workflow(tmp_path: Path) -> Callable[..., Path]:
    """Write workflows/<id>.yaml into tmp_path/workflows; return the dir."""

    def _write(workflow: dict[str, Any]) -> Path:
        wf_dir = tmp_path / "workflows"
        wf_dir.mkdir(exist_ok=True)
        (wf_dir / f"{workflow['id']}.yaml").write_text(
            yaml.safe_dump(workflow, sort_keys=False), encoding="utf-8"
        )
        return wf_dir

    return _write


@pytest.fixture()
def write_skillset(tmp_path: Path) -> Callable[..., Path]:
    """Write skillsets/<id>.yaml into tmp_path/skillsets; return the dir."""

    def _write(skillset: dict[str, Any]) -> Path:
        ss_dir = tmp_path / "skillsets"
        ss_dir.mkdir(exist_ok=True)
        (ss_dir / f"{skillset['id']}.yaml").write_text(
            yaml.safe_dump(skillset, sort_keys=False), encoding="utf-8"
        )
        return ss_dir

    return _write
