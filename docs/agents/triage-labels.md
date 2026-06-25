# Triage Labels

This file is the **network label standard** for this repo. The standard is owned by the
control-plane repo (`itradeaims-agent-workflows`): the human guide is its
`docs/agents/triage-labels.md` and the machine source of truth is its
`registry/network-labels.json`. Labels are synced to all repos from the control-plane with
`scripts/sync_network_labels.py`.

The engineering skills speak in terms of five canonical triage roles. This file maps those roles to the label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in this tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

If GitHub does not have one of these labels yet, create it before applying it or ask the owner whether to map to an existing stock label.

## Exclusive Workflow State

Apply at most one workflow-state label to an issue at a time. Workflow-state labels are mutually exclusive routing decisions, not descriptive tags:

- `needs-triage`
- `needs-info`
- `ready-for-agent`
- `ready-for-human`
- `wontfix`
- `prd`
- `state:idea`
- `state:shaped`
- `state:in-progress`
- `state:review-needed`
- `status:blocked`

Topic labels such as `agent-workflows`, `mcp`, or `documentation` may still be used when they add routing context, but they must not change the workflow state.

`prd` is a HITL state. A PRD issue stays labelled `prd` until a human or lead turns it into independently executable implementation slices. Do not combine `prd` with `ready-for-agent` or `ready-for-human`.

`to-issues` output must choose exactly one workflow-state label per generated issue. Use `ready-for-agent` only for fully specified AFK implementation slices. Use `ready-for-human` for non-PRD HITL slices that require owner judgment. Use `prd` for PRD artifacts and do not add a pickup label to the same issue.

## Agent Fleet Pilot Labels

The first agent-fleet pilot adds a state machine for dispatchable agent work. Use one active state label per issue:

| Label | Meaning |
| --- | --- |
| `state:idea` | Captured but not shaped. No agent starts work. |
| `state:shaped` | Clarified enough for read-only scouting or acceptance-criteria suggestions. |
| `ready-for-agent` | Fully specified and approved for one agent to claim. |
| `state:in-progress` | Claimed by an agent. |
| `state:review-needed` | Work is ready for review, validation, or owner decision. |
| `status:blocked` | Needs owner input, external action, or an unresolved dependency. |

Agents may only move labels through the transition set documented in the Agent Fleet Dispatch Guide (see control-plane `docs/guides/agent-fleet-dispatch.md`). Owner or lead approval is required to promote issues into `ready-for-agent`, close issues, or move blocked work back into the executable queue.
