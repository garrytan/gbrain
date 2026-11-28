**Enforce embedding run budgets across foreground and queued work.**

### Fixed
- Carry explicit job approvals to workers and compose configured embedding caps with enclosing budgets.
- Reserve provider token ceilings before each request and retain the reservation when usage is unknown.

<!-- behavior-change: embedding_run_budget_enforcement -->
