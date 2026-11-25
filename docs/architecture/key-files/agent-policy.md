# Key files: Agent policy and capability probe

[Subsystem index](../KEY_FILES.md) · [Previous entries](security-continued.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.
User guide: `docs/guides/agent-policy.md`. Advisory only: nothing here blocks an action.

- `src/core/agent-verbs.ts` — The one verb vocabulary (`AGENT_VERBS`, `SPEND_PURPOSES`, `RECIPIENT_CLASSES`) shared by policy rules, the action ledger and household actions. Other lanes copy it byte for byte; change it in one PR for all.

- `src/core/policy/fence.ts` — The `gbrain:policy v1` fence: strict parser (line and column on error; any unknown verb, decision, class, window or limit makes the whole fence malformed), `renderPolicyFence` (canonical form) and `policyDigest` (sha256 of the canonical form, what an approval binds).

- `src/core/policy/evaluate.ts` — Merchant rules, then condition rules (amount, recipient), then the verb's plain rule; deny beats ask beats allow within a tier; a verb with no rule answers ask; a currency mismatch, or a deny or ask rule whose field (merchant, to, amount) the check leaves out, gives a provisional ask that a stricter later rule overrides; `stricterVerdict` combines scopes.

- `src/core/policy/presets.ts` — `ask-all` (default) and `gskills-level-0..3`, derived from gskills levels.json at a pinned commit: every level asks before send, spend, delete and publish; level 2 denies send, spend and call.

- `src/core/policy/authority.ts` — Owner authority (decision F1): `terminalAuthorityProblem` (agent marker via `ownerWriteAgentMarker`, or no TTY), `confirmOnTerminal` (owner types the first 8 hex of the digest; `probe.readAnswer` test seam), `confirmRequiredError` (`policy_confirm_required`, fix actor user with the exact argv) and `withOwnerProof`, the only way into `withReservedConfigWrite` (both engines' setConfig/unsetConfig refuse `policy.approved.*` outside it).

- `src/core/policy/store.ts` — Page at `policy/agent` / `company/policy/agent` (source default, type agent_policy, private) plus the approval record in config `policy.approved.<scope>`. `resolvePolicy` states: none, ok, unapproved (non-authoritative: every verb asks), malformed and changed_outside_gbrain (both serve the last approval; malformed with no approval asks for every verb). `applyPolicyChange` writes a pending revision and refuses without owner authority; `acceptRevision` binds the current revision only (`policy_revision_stale` otherwise).

- `src/core/policy/check.ts` — `checkPolicy` / `describePolicy` for the ops and CLI; `callerScopes` (local, owner and unbound callers read both scopes; a member, group, guest, several-member audience, attested scope read or call with no access record reads the company scope only); `policyStateForPack` (context_pack's `policy_state`, with a 7-day change notice from the stored proof).

- `src/core/policy/admission.ts` — Write admission: `assertPolicySlugWrite` (remote writes naming a policy slug, as target or rename destination) and `admitPolicyFrontmatter` (remote writes that are or would become agent_policy) refuse with `policy_owner_only`; local writes are forced `visibility: private`.

- `src/core/ops/policy.ts` — `policy_check`, `agent_policy` and `capabilities` (served / listed / granted / callable per op through `hiddenToolRoute`; a callable-but-unlisted op gets a discovery line and never a regrant).

- `src/commands/policy.ts` — `gbrain policy` (init, show, allow, ask, deny, edit, accept, check, presets, status). CLI-only, refused on thin clients and enforced members.

- `src/core/setup/policy-line.ts` — The brain-first policy line: off by default (`brain_first.policy_line`), rendered only where policy_check is reachable (CLI, full, starter via request_tools; never verbs). `refreshPolicyLineBlocks` in `brain-first-upgrade-notice.ts` rewrites installed blocks when the setting changes.

- `src/commands/doctor/checks/policy-valid.ts` — `policy_valid`: warns on malformed, unapproved or changed_outside_gbrain with the next step.
