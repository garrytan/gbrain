"""Build a redacted synthetic Hermes state.db through pinned SessionDB APIs.

The fixture is intentionally synthetic. It exercises the pinned host's real
schema initialization and write paths; manual state toggles are explicit
negative probes, not claimed to come from native append semantics.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

PIN = "46d7718a52ff33accb15dc0501736fbdb6833cab"


def build(destination: Path) -> None:
    checkout = Path(os.environ["HERMES_API_CHECKOUT"]).resolve()
    actual = subprocess.check_output(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual != PIN:
        raise RuntimeError(f"Hermes checkout must be pinned to {PIN}")
    sys.path.insert(0, str(checkout))
    from hermes_state import SessionDB

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)
    db = SessionDB(destination)
    try:
        db.create_session("fixture-cli", "cli", profile_name="default")
        db.append_message("fixture-cli", "user", "SYNTHETIC-CUTOFF-USER", timestamp=1785916805)
        db.append_message("fixture-cli", "assistant", "SYNTHETIC-ARCHIVE-ANSWER", timestamp=1785916810)
        db.append_message("fixture-cli", "user", "SYNTHETIC-REWOUND-TURN", timestamp=1785916815)
        db.append_message("fixture-cli", "assistant", "SYNTHETIC-COMPACTED-TURN", timestamp=1785916820)
        db.create_session("fixture-gateway", "gateway", profile_name="private")
        db.append_message("fixture-gateway", "user", "SYNTHETIC-OTHER-SOURCE", timestamp=1786003205)
        db.append_message("fixture-gateway", "assistant", "SYNTHETIC-OTHER-ANSWER", timestamp=1786003210)
    finally:
        db.close()

    # Set host-native flags only after the real API-generated rows exist.
    # Current archive import intentionally retains these turns.
    import sqlite3

    with sqlite3.connect(destination) as conn:
        # The checked-in artifact is a portable single-file image. Live WAL
        # behavior is exercised separately with a real open writer in Bun.
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("UPDATE messages SET active=0 WHERE content='SYNTHETIC-REWOUND-TURN'")
        conn.execute("UPDATE messages SET active=0, compacted=1 WHERE content='SYNTHETIC-COMPACTED-TURN'")
    for suffix in ("-wal", "-shm", ".quarantine.lock", ".fts_rebuild.lock"):
        Path(str(destination) + suffix).unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: build_state_fixture.py <output-state.db>")
    build(Path(sys.argv[1]).resolve())
