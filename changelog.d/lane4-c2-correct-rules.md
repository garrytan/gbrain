**When you correct your agent, one `correct` call saves your words as a standing rule and fixes the wrong fact, and your agents load the rule once you approve it.**

<!-- behavior-change: standing_rules_correct_gst3827 -->

### Added
- The MCP tool `correct` and `gbrain correct "<rule>" [--fact-id N --corrected-fact "<text>"]` save a standing rule (`rules/me/<name>` or `rules/team/<name>`), then replace the wrong fact (or withdraw it, never purge it), then mark the rule active. Each step has its own request id, so `gbrain correct resume <receipt>` or a replay finishes a stopped correction without writing twice.
- The receipt says `committed`, `pending`, `partial`, `proposed` or `conflicted`, what has taken effect, and the next step with who takes it (the agent, the owner, or the brain host's operator).
- A rule from your own agent is searchable at once and reaches the standing-rules section only after you approve its exact revision with `gbrain rules approve <id>@<revision>`; at your own terminal, `gbrain correct` asks for a short code and confirms it there. Another member's rule stays proposed, and the fact unchanged, until you approve it.
- `context_pack` takes `include_rules: true` and `gbrain compile-context` takes `--include-rules`; both add your confirmed rules (at most 30 rules and 1,500 characters) as labelled data. The session-start section stays off until `gbrain config set rules.session_start on`.
- `gbrain rules list|show|approve|retire|check` and the doctor check `rules_regression`.

### Changed
- Remote writes to `rules/` pages, or of `type: rule` pages, outside `correct` are refused (`rule_owner_only`), and a standing rule (a `rules/` page) only moves forward: from proposed to active, and from active to retired, never back.
- The correction-pipeline skill uses `correct` for wrong facts in the facts table and for hallucination guards.
