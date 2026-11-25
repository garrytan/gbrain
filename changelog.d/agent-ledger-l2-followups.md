### Fixed

- Agent spending budgets count a live hold until it is settled, even past midnight UTC, and count the settled spend on the day it was paid.
- `gbrain ledger` totals for a member are never cut short by other people's actions, and a correction counts only once it is done.
- A retried `log_action` or `policy_reserve` that changed the call is refused instead of replaying the first one, and a reserve retry keeps its first answer.
- A member's receipt page counts as evidence when the member can read it the ordinary way.
- Budget sums are exact for decimal amounts: 0.10 used and 0.20 asked fits a 0.30 budget.
