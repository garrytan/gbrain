# Key files: Agent policy, capability probe and action ledger

[Subsystem index](../KEY_FILES.md) · [Previous entries](security-continued.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.
User guides: `docs/guides/agent-policy.md`, `docs/guides/action-ledger.md`. Advisory only: nothing here blocks an action.

- `src/core/agent-verbs.ts` — The one verb vocabulary (`AGENT_VERBS`, `SPEND_PURPOSES`, `RECIPIENT_CLASSES`) shared by policy rules, the action ledger and household actions. Other lanes copy it byte for byte; change it in one PR for all.

- `src/core/policy/fence.ts` — The `gbrain:policy v1` fence: strict parser (line and column on error; any unknown verb, decision, class, window or limit makes the whole fence malformed), `renderPolicyFence` (canonical form) and `policyDigest` (sha256 of the canonical form, what an approval binds).

- `src/core/policy/evaluate.ts` — Merchant rules, then condition rules (amount, recipient), then the verb's plain rule; deny beats ask beats allow within a tier; a verb with no rule answers ask; a currency mismatch, or a deny or ask rule whose field (merchant, to, amount) the check leaves out, gives a provisional ask that a stricter later rule overrides; a day, week or month limit is a budget (amount plus the window's used spend and live holds, passed in as `UsageByRule`; unreadable usage is a provisional ask); `stricterVerdict` combines scopes.

- `src/core/policy/presets.ts` — `ask-all` (default) and `gskills-level-0..3`, derived from gskills levels.json at a pinned commit: every level asks before send, spend, delete and publish; level 2 denies send, spend and call.

- `src/core/policy/authority.ts` — Owner authority (decision F1): `terminalAuthorityProblem` (agent marker via `ownerWriteAgentMarker`, or no TTY), `confirmOnTerminal` (owner types the first 8 hex of the digest; `probe.readAnswer` test seam), `confirmRequiredError` (`policy_confirm_required`, fix actor user with the exact argv) and `withOwnerProof`, the only way into `withReservedConfigWrite` (both engines' setConfig/unsetConfig refuse `policy.approved.*` outside it).

- `src/core/policy/store.ts` — Page at `policy/agent` / `company/policy/agent` (source default, type agent_policy, private) plus the approval record in config `policy.approved.<scope>`. `resolvePolicy` states: none, ok, unapproved (non-authoritative: every verb asks), malformed and changed_outside_gbrain (both serve the last approval; malformed with no approval asks for every verb). `applyPolicyChange` writes a pending revision and refuses without owner authority; `acceptRevision` binds the current revision only (`policy_revision_stale` otherwise).

- `src/core/policy/check.ts` — `checkPolicy` / `describePolicy` for the ops and CLI; `callerScopes` (local, owner and unbound callers read both scopes; a member, group, guest, several-member audience, attested scope read or call with no access record reads the company scope only); `policyStateForPack` (context_pack's `policy_state`, with a 7-day change notice from the stored proof).

- `src/core/policy/admission.ts` — Write admission: `assertPolicySlugWrite` (remote writes naming a policy slug, as target or rename destination) and `admitPolicyFrontmatter` (remote writes that are or would become agent_policy) refuse with `policy_owner_only`; local writes are forced `visibility: private`.

- `src/core/ops/policy.ts` — `policy_check`, `agent_policy` and `capabilities` (served / listed / granted / callable per op through `hiddenToolRoute`; a callable-but-unlisted op gets a discovery line and never a regrant).

- `src/commands/policy.ts` — `gbrain policy` (init, show, allow, ask, deny, edit, accept, check, presets, status). CLI-only, refused on thin clients and enforced members.

- `src/core/setup/policy-line.ts` — The brain-first policy line: off by default (`brain_first.policy_line`), rendered only where policy_check is reachable (CLI, full, starter via request_tools; never verbs). `refreshPolicyLineBlocks` in `brain-first-upgrade-notice.ts` rewrites installed blocks when the setting changes.

- `src/commands/doctor/checks/policy-valid.ts` — `policy_valid`: warns on malformed, unapproved or changed_outside_gbrain with the next step.

- `src/core/ledger/action.ts` — The agent_action page: `actions/YYYY/MM/<id>` (`actionSlug`: time from `at`, the rest from a hash of actor and request_id, so a replay names the same page), the strict frontmatter shape (`validateActionFrontmatter`; unknown keys refused, `trust_tier` is server-stamped) and status transitions (`canTransition`; done is never edited, only reversed).

- `src/core/ledger/admission.ts` — Write admission: remote writes onto an action slug, or that declare or keep type agent_action, refuse with `ledger_log_action_only`; local writes are validated strictly (`action_invalid`) and forced private.

- `src/core/ledger/store.ts` — `logAction` and `policyReserve` write through the page write path as trusted internal writes after stamping the actor (`actorFor`) and computing claim_basis (a ref resolves to a page the writer can read); a replay is found by its derived write request id. `ledgerReader`: owner, local and unbound callers read every action, a member reads pages whose readable_by names it, anyone else none. `scanActions` is bounded (`LEDGER_SCAN_MAX`; past it `ledgerReport` returns state partial with no totals). `policyReserve` checks and holds under one lock (an in-process chain plus the `gbrain-ledger-reserve` db lock); an expired hold is ignored, never rewritten.

- `src/core/ledger/totals.ts` — Totals per currency split by claim basis, verb and counterparty (done and not superseded only; minutes_saved never totalled), `windowUsage` for budgets, UTC `windowStart` (weeks from Monday) and the deterministic weekly digest.

- `src/core/ops/ledger.ts` — `log_action`, `ledger` and `policy_reserve`. `src/commands/ledger.ts` — `gbrain ledger` (totals, add, confirm, digest); confirm refuses from an agent session or with no terminal (`ledger_confirm_required`).
