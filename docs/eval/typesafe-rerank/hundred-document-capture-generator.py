"""Extend the frozen Atlas pilot grammar to 100 candidates, without changing its sources."""
import json
from pathlib import Path

QUERY = "Which access policy was approved for the Atlas launch?"
FILLER = " The team discussed monitoring dashboards, deployment checklists, review meetings, routine coordination, and preparation notes."
GOLD = "The approved Atlas launch access policy was invite-only access for internal employees."

pools = []
for chars in (1000, 6000):
    candidates = []
    for index in range(100):
        gold = index == 99
        note_index = index % 9 if chars == 1000 else index
        prefix = GOLD if gold else (
            f"Atlas planning note {note_index}. It describes schedules and review activities "
            "but does not record the approved access policy."
        )
        candidates.append({
            "id": "candidate-gold" if gold else f"candidate-{index}",
            "text": (prefix + FILLER * ((chars + len(FILLER) - 1) // len(FILLER)))[:chars],
        })
    pools.append({
        "id": f"profile-100x{chars}", "query": QUERY,
        "group": "synthetic-atlas-hundred", "candidates": candidates,
        "relevant": ["candidate-gold"],
    })

Path(".context/typesafe-100-doc-pools.jsonl").write_text(
    "\n".join(json.dumps(pool, separators=(",", ":")) for pool in pools) + "\n"
)
