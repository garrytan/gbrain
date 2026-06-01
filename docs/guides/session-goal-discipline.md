# Session Audit And Goal Discipline

## Goal
Know how to start a non-trivial GBrain session the right way: audit repo and runtime truth first, do the needed research, write the right docs, set or continue the session goal only after the scope is real, and leave a clean verification trail.

## What the User Gets
Without this: the session starts with a vague objective, the agent grabs stale context, skips the expensive questions, mutates code before the shape of the work is understood, and ends with hand-wavy "done" claims. With this: the session starts from source truth, the real acceptance gate is named early, documentation keeps up with the work, goals stay useful instead of ornamental, and the closeout survives scrutiny.

## Implementation

```
on non_trivial_session_start(task):
    # 0. Protect the checkout first.
    run("git status --short --branch")
    if on_protected_branch():
        move_to_branch_or_worktree()

    # 1. Audit repo truth before proposing a lane.
    if repo_inventory_available():
        run("repo_inventory.py <repo>")
    read("AGENTS.md")
    read("CLAUDE.md")
    inspect_nearby_docs_and_recent_commits()
    if task_touches_agent_surface():
        run("agent-surface-audit")

    # 2. Audit runtime truth for the thing that actually matters.
    if task_touches_gbrain_runtime():
        run("gbrain models")
        run("gbrain providers list")
        run("gbrain sources list --json")
        run("gbrain sources current --json")
        # Serialize these three to avoid local lock contention.
        run("gbrain config show")
        run("gbrain doctor --json")
        run("gbrain stats")

    # 3. State the acceptance gate early.
    acceptance_gate = pick_gate(
        tests | build | screenshot | receipt | runtime_readback | source_count_parity
    )

    # 4. Decide whether this is strategy or execution.
    if scope_is_fuzzy_or_architectural():
        write_spec()
        write_plan()
    else:
        execute_directly()

    # 5. Set or continue the session goal AFTER the audit.
    # The goal should name the actual end state, not the first hunch.
    if goals_enabled_and_user_wants_goal():
        set_or_continue_goal(
            concrete_objective = describe_real_end_state(),
            acceptance_gate = acceptance_gate
        )

    # 6. Autotune the goal only when the end state changes materially.
    if user_changes_outcome() or audit_proves_goal_is_wrong():
        tighten_plan_and_docs()
        replace_goal_text_for_the_new_end_state()
    else:
        keep_goal_stable()

    # 7. Route durable information to the right layer.
    if info_is_world_knowledge():
        write_to_gbrain()
    elif info_is_operational_preference():
        write_to_memory()
    elif info_is_repo_operating_rule():
        update_repo_docs_or_agents()

    # 8. Close with proof, residue, and exact next move.
    rerun_acceptance_gate()
    rerun("git status --short --branch")
    report(changed, verified, residue, next_move)
```

### The Session Audit Checklist

1. **Branch safety**
   - Confirm current branch state with `git status --short --branch`.
   - If the work is non-trivial and the checkout is `main`, `master`, or another protected branch, stop and move to the repo's branch/worktree flow.

2. **Repo truth**
   - Read `AGENTS.md` and `CLAUDE.md` first.
   - If the task is about repo setup, design, MCP, skill, or workflow, run
     `repo_inventory.py` first when available. A repo-local copy is fine; a
     shared host-tooling copy is also valid.
   - If the work changes agent surfaces (`AGENTS.md`, skills, workflows, MCP
     wiring, or copied workflow authority), run an agent-surface audit before
     creating more durable workflow files.
   - Read the closest docs before proposing a solution.

3. **Runtime truth**
   - For GBrain runtime questions, trust live CLI readback over stale summaries:
     - `gbrain models`
     - `gbrain providers list`
     - `gbrain sources list --json`
     - `gbrain sources current --json`
   - For health checks, serialize:
     - `gbrain config show`
     - `gbrain doctor --json`
     - `gbrain stats`

4. **Acceptance gate**
   - Pick the proof before doing the work.
   - Examples:
     - runtime migration -> source count parity + search parity + MCP smoke
     - docs/process update -> file landed + instructions cross-linked + no contradiction with AGENTS
     - workflow or agent-surface update -> inventory run + surface audit + durable doc cross-link
     - bugfix -> focused test or reproducible runtime readback

5. **Documentation**
   - If the work changes how operators should run the system, write or update a durable doc in `docs/guides/`.
   - If the work changes repo-local operating behavior, add the short version to `AGENTS.md`.
   - If the thread is long or strategic, leave a handoff artifact or plan instead of burying the decision in chat.

6. **Goal timing**
   - Do not set the goal from the user's first rough phrasing if the scope is still muddy.
   - Audit first, then set the goal once the real end state is visible.
   - Good goals name the finished state and the proof:
     - `Cut over the production GBrain to Postgres/Supabase, re-register sources, verify page/search parity, and switch MCP traffic.`
     - `Finish the production-brain cost audit, write the operator guide, and leave the exact next migration move with receipts.`

7. **Goal autotune rules**
   - Keep the goal stable through tactic changes.
   - Retune it only when:
     - the user changes the desired outcome,
     - the audit proves the current objective is too vague to verify, or
     - the owning repo/runtime boundary changes the real job.
   - Do not churn the goal for every subtask.
   - Before retuning, update the plan/doc/handoff so the change is auditable.

8. **Storage discipline**
   - World facts -> GBrain
   - Operating preferences and workflow continuity -> agent memory
   - Repo-local process rules -> `AGENTS.md` and repo docs
   - Current ephemeral discussion -> session only

## Tricky Spots

1. **A vague goal is worse than no goal.** If the goal is set before the audit, the rest of the session bends around the wrong objective. Audit first, then set the goal from evidence.
2. **Runtime summaries drift.** On GBrain work, `gbrain models`, `providers list`, and `sources list/current` beat coarse summaries every time. Re-read them before closing.
3. **`gbrain doctor --json` is noisy up front.** It streams phase markers before the final JSON payload. Wait for the command to finish, then interpret the final object.
4. **Docs are part of the job.** If you changed how the system should be operated and you only mention it in chat, you did not finish the job.
5. **Memory is not a dumping ground.** Save operational guidance to memory, but keep world knowledge in GBrain and repo-specific operating rules in the repo.
6. **Don't let `/goal` become decorative.** If a goal cannot be proven with a real gate, rewrite it until it can.

## How to Verify

1. Start a non-trivial repo task and confirm the first moves are repo truth, runtime truth, and branch safety — not editing.
2. Check that the acceptance gate is named before implementation starts.
3. For a strategic task, confirm there is a durable doc or plan in the repo, not only chat output.
4. For a GBrain runtime audit, confirm the session uses `gbrain models`, `gbrain providers list`, `gbrain sources list --json`, and `gbrain sources current --json` before making routing or cost claims.
5. Before closeout, confirm the gate was rerun and `git status --short --branch` was checked again.

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
