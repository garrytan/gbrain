"""Pytest configuration for pre-trade-discipline-gate tests."""

import sys
from pathlib import Path

scripts_dir = Path(__file__).resolve().parents[1]
if str(scripts_dir) not in sys.path:
    sys.path.insert(0, str(scripts_dir))
