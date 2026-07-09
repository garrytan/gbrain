"""Regression test for sync-brand-to-tokens.cjs.

The color parser required a parenthesized name in the Quick Reference row
(`#2563EB (name)`) and a bolded label in the color tables (`**Primary Blue**`),
neither of which the bundled starter template uses. As a result the base hex
came back `undefined` and `adjustBrightness(undefined)` threw a TypeError —
i.e. the script crashed on its own documented happy path. This test runs the
sync against the bundled starter template and asserts it completes and writes
the expected base colors. It is pytest-based so the existing pytest CI runs it.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent
SCRIPT = SCRIPTS / "sync-brand-to-tokens.cjs"
BRAND_STARTER = SCRIPTS.parent / "templates" / "brand-guidelines-starter.md"
TOKENS_STARTER = (
    SCRIPTS.parent.parent / "design-system" / "templates" / "design-tokens-starter.json"
)


def test_sync_parses_bundled_starter_template(tmp_path):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")

    (tmp_path / "docs").mkdir()
    (tmp_path / "assets").mkdir()
    shutil.copy(BRAND_STARTER, tmp_path / "docs" / "brand-guidelines.md")
    shutil.copy(TOKENS_STARTER, tmp_path / "assets" / "design-tokens.json")

    result = subprocess.run(
        [node, str(SCRIPT)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )

    # Must not crash (the bug raised an unhandled TypeError).
    assert "TypeError" not in result.stderr, result.stderr
    assert result.returncode == 0, result.stderr + result.stdout

    tokens = json.loads((tmp_path / "assets" / "design-tokens.json").read_text())
    primitive = tokens["primitive"]["color"]
    assert primitive["primary"]["500"]["$value"] == "#2563EB"
    assert primitive["secondary"]["500"]["$value"] == "#8B5CF6"
    assert primitive["accent"]["500"]["$value"] == "#10B981"
