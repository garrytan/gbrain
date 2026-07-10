"""Shared fixtures for trade-hypothesis-ideator tests."""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
SKILL_DIR = SCRIPTS_DIR.parent
EXAMPLES_DIR = SKILL_DIR / "examples"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture()
def example_input() -> dict:
    """Load example input bundle."""
    return json.loads((EXAMPLES_DIR / "example_input.json").read_text())


@pytest.fixture()
def example_output() -> dict:
    """Load example output bundle."""
    return json.loads((EXAMPLES_DIR / "example_output.json").read_text())


@pytest.fixture()
def base_hypothesis_card(example_output: dict) -> dict:
    """Provide a mutable baseline hypothesis card for tests."""
    return deepcopy(example_output["hypotheses"][0])


@pytest.fixture()
def raw_hypotheses_payload(example_output: dict) -> dict:
    """Build --hypotheses payload shape from example output."""
    return {"hypotheses": deepcopy(example_output["hypotheses"])}
