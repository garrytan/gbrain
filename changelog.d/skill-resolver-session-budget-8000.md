**Long sessions keep getting skill suggestions: the resolver's per-session budget now defaults to 8,000 tokens instead of 2,000.**

### Changed
- `skills.resolver.session_token_budget` defaults to 8,000. At 2,000 a session's budget ran out around turn 20, and after that the right skill showed on 5 of 143 later turns in Claude Code (1 of 143 in Codex) in the skill bench's session replay; at 8,000 the budget lasted all 30 turns and the right skill showed on 41 and 26 of 143. Set it back with `gbrain config set skills.resolver.session_token_budget 2000`.

<!-- behavior-change: skill_resolver_session_budget_8000_gst3459 -->
