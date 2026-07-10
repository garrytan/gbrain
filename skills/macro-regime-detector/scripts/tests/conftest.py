"""Shared fixtures for Macro Regime Detector tests"""

import os
import sys

# Add scripts directory to path so calculators can be imported
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
# Add tests directory to path so test helpers can be imported
sys.path.insert(0, os.path.dirname(__file__))
