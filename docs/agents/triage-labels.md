# Triage roles and existing GitHub labels

Do not create labels from generic workflow role names. Map each role to the
labels that already exist in `garrytan/gbrain`:

| Workflow role | Existing tracker label | Meaning |
|---|---|---|
| `needs-triage` | `needs-review` | A human needs to classify the item |
| `needs-info` | `question` | More information is required from the reporter |
| `ready-for-agent` | No single label | Use `fix-needed` for a confirmed bug or `feature-consider` for a proposal, plus `p0`/`p1`/`p2`/`p3` when priority is known |
| `ready-for-human` | `needs-maintainer-decision` | Resolution requires a maintainer product or policy decision |
| `wontfix` | `wontfix` | Will not be actioned |

Use `documentation`, `bug`, `enhancement`, `sync`, or `skillopt` for subject
classification where applicable. `good first issue` means suitable for a
newcomer; it is not a generic agent-ready marker.
