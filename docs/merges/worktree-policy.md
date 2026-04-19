# Worktree Policy for Parallel Agent Lanes

## Purpose

This policy isolates branch editing by role so concurrent agent lanes do not overwrite each other's in-progress files.

The primary repository at `~/projects/gbrain` is treated as the archive of record. Normal lane work happens in role-specific worktrees under `~/projects/gbrain-worktrees/`.

## Durable Worktree Topology

| Role | Worktree path | Branch ownership |
|---|---|---|
| Staff | `~/projects/gbrain-worktrees/staff` | `staff/*` |
| Implementation | `~/projects/gbrain-worktrees/impl` | `impl/*`, `atlas/*` |
| CTO | `~/projects/gbrain-worktrees/cto` | `cto/*` |
| Release | `~/projects/gbrain-worktrees/release` | `master`, `release/*` |

QA stays on ephemeral `/private/tmp/gbrain-*` worktrees for read-only verification. QA ephemeral paths are outside this durable policy.

## Branch-Prefix Contract

1. Staff works only on `staff/*` branches from the Staff worktree.
2. Implementation works only on `impl/*` and `atlas/*` branches from the Implementation worktree.
3. CTO works only on `cto/*` branches from the CTO worktree.
4. Release owns `master` and `release/*` branches from the Release worktree.
5. A branch may be checked out in only one worktree at a time. Do not use force options to bypass this.

## Agent Adapter Configuration Contract

Each durable role must set:

- `adapterConfig.cwd` to its role worktree path
- `adapterConfig.workspaceStrategy` to `per_agent_worktree`

The `workspaceStrategy` value is a declarative marker so future tooling can verify policy compliance.

Only the CEO or the original agent creator may patch another agent's adapter config. Non-creator lane owners must either:

- self-patch their own agent on their own heartbeat, or
- request CEO action for cross-agent migration updates.

## Workflow Rules

1. Do branch switches inside your own role worktree.
2. Do not edit in the primary repo during normal execution.
3. Do not reuse another role's durable worktree path.
4. If an agent heartbeat starts before a cwd update is picked up, complete that heartbeat and verify the next heartbeat runs from the updated cwd.

## Adding a New Durable Role

1. Create `~/projects/gbrain-worktrees/<role>`.
2. Create or attach a branch prefix contract for that role.
3. Patch that agent's `adapterConfig.cwd` and set `adapterConfig.workspaceStrategy="per_agent_worktree"` (self-patch or CEO/creator patch only).
4. Update this document with the new topology row and branch prefix mapping.

## Escape Hatch

If you must inspect a branch outside the durable role worktrees, create a short-lived throwaway worktree under `/private/tmp/`.

Example:

```bash
git -C ~/projects/gbrain worktree add /private/tmp/gbrain-debug-<ticket> <branch>
```

Never repurpose another role's durable worktree for cross-role inspection.
