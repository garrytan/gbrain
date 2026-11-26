**Agents can record what they did for you outside the brain, and gbrain totals it with evidence.**

### Added
- `log_action` MCP tool and `gbrain ledger add`: one private `agent_action` page per outside action at `actions/YYYY/MM/<id>`, with a strict shape, the actor stamped by gbrain and `claim_basis` (evidenced, user_confirmed, estimated) computed on the server. An amount needs readable evidence or `estimated: true` (`money_unevidenced`).
- `ledger` MCP tool and `gbrain ledger [--since]`: totals per currency split by claim basis, verb and counterparty, over the actions the caller can read; a window too large returns `state: partial` and the narrower call. `gbrain ledger digest --week [--save]` writes the week as deterministic text.
- `gbrain ledger confirm <action_id>` marks a done action's amounts as confirmed by the user; it refuses from an agent session or with no terminal (`ledger_confirm_required`).
- Agent policy budgets: `--window day|week|month` on `gbrain policy allow|ask|deny`. `policy_check` returns each budget as advice and `requires_approval`; the new `policy_reserve` tool checks the budget and holds the amount for 24 hours in one locked step, settled by `log_action` (a settle with no amount records the held amount as an estimate).

### Changed
- Remote callers cannot write action pages directly (`ledger_log_action_only`), and ledger reads and writes follow the connection's source grants; `actions/` pages are demoted in search like `extracts/`.

<!-- behavior-change: action_ledger_l2_gst3824 -->
