# Doctor skill roots

**Say to your agent:** *“Check my skills using my workspace and the approved Workshop skill directory, without changing either.”*

Doctor's read-only skill checks can resolve a relocated skill without copying it
back, creating symlinks, or rewriting a manifest. The workspace skill directory
remains first in precedence. Additional roots must be explicitly supplied by the
local operator, in precedence order:

```sh
GBRAIN_SKILL_ROOTS='["/absolute/approved-workshop-skills"]' \
  gbrain check-resolvable --skills-dir /absolute/workspace/skills --json
```

The same environment input applies to Doctor's resolver, conformance, brain-first,
and currency checks. `checkResolvable`, `skillConformanceCheck`,
`skillBrainFirstCheck`, and `computeSkillCurrency` also accept `skillRoots` as an
array; an explicit empty array disables environment roots. Roots are validated
as existing, readable absolute directories (maximum 32). Invalid roots remain
visible diagnostic failures. No OpenClaw configuration is changed or inferred.

For Workshop, obtain the selected agent's actual root from the host's configured
`agentDir` and append `workshop-skills`. Do not guess an agent name, enumerate
other agents, or infer approval from a path mentioned in skill content. A process
checking multiple workspaces must pass each workspace's own approved roots, not
reuse another agent's environment.

## Resolution and evidence

- References retain their existing portable relative form, such as
  `example-skill/SKILL.md` in the manifest or
  `skills/example-skill/SKILL.md` in the dispatcher.
- Flat skill directories in approved roots extend the read-only inventory. The
  workspace manifest remains unchanged, including genuinely missing entries.
- The first existing candidate wins. A malformed, unreadable, non-file, dangling,
  or out-of-bounds higher-priority candidate is not replaced by a healthy copy
  from a lower-priority root.
- Traversal, absolute references, backslashes, control characters, and empty
  path components are rejected. Files reached through symlinks must remain
  inside an approved root. A symlink never approves its own external target.
- `createSkillPaths().locate()` returns the actual canonical file path, selected
  root, and workspace/explicit provenance, or the reason resolution failed.
- The trigger index reads actual frontmatter from the selected file. Relocation
  does not create triggers, excuse an unreachable skill, waive conformance, or
  exempt external lookups from brain-first checks.
- Currency compares the selected install's bytes with the bundle. Missing
  supporting files remain drift; local edits are legitimate drift, not current.

This is a diagnostic lookup contract, not a full reproduction of a host's skill
loader, allowlists, eligibility gates, grouped layouts, or activation state.
Physical presence and static reachability do not prove host activation.

## Read-only verification and deployment

`check-resolvable` without `--fix` reads files only and never runs skill bodies.
For an in-process inventory comparison, call the checks directly with explicit
roots and `skillBrainFirstCheck(dir, { skillRoots, audit: false })`; this avoids
brain-first snapshot/audit writes. Incomplete brain-first scans do not clear
previous violations or label unread files compliant.

A full Doctor invocation can record audit state even without `--fix`.
`--no-migrate` prevents schema migration, but is not a global no-write guarantee.
Use the direct file-check functions for a strictly read-only differential.

Additional roots do not expand any repair/write target. Existing `--fix`,
scaffolding, manifest writes, and skill installation remain workspace-only;
changes to Workshop-owned files belong to the host's approval flow. This repair
requires no corpus/schema migration or service restart. After review, use the
normal release process, or test the isolated source checkout with per-process
approved roots before separately authorizing deployment.
