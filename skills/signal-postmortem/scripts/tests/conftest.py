"""
Pytest configuration for signal-postmortem tests.
"""

import sys
from pathlib import Path

# Add scripts directory to path for imports
scripts_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(scripts_dir))
