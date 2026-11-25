**Agents can ask your brain whether they may send, spend, delete or sign up for you, and which gbrain tools their connection can call.**

### Added
- `gbrain policy` (init, show, allow, ask, deny, edit, accept, check, presets, status) keeps an owner-approved agent policy at `policy/agent` (and `company/policy/agent` for a shared brain). Presets: `ask-all` (the default) and four levels matching gskills' action levels.
- `policy_check` and `agent_policy` MCP tools answer from the approved policy: allow, ask, deny or none, with the rule and revision. Advisory only; harness approvals still apply.
- `capabilities` MCP tool: for each op, whether this build serves it and this connection can list and call it, with the fix when it cannot.
- Doctor check `policy_valid`; `context_pack` carries `policy_state`; owner-session approval at `POST /admin/api/policy/accept`.

### Changed
- An agent policy change from an agent session, or with no terminal, is refused with `policy_confirm_required` and waits as a pending revision. `gbrain config set policy.approved.*` is refused, and remote writes to the policy page get `policy_owner_only`.
- The brain-first policy line is off by default: `gbrain config set brain_first.policy_line on` adds it, `off` removes it.

<!-- behavior-change: agent_policy_l1_gst3824 -->
