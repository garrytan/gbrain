**The brain owner's own agent can list and read pinned questions over MCP.**

Previously, the questions tools refused the owner's credential once the brain
had a member. The owner's own unfenced credential can now use
`questions_list` and `questions_status` for pins with a page it can read.
Saved answers withhold sentences drawn from evidence outside the credential's
current access. Pin management and pinned answers in `context_pack` keep
their existing access rules.

<!-- behavior-change: questions_owner_remote -->
