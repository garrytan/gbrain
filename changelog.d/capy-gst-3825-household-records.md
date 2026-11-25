**Your agent can now ask GBrain what needs doing at home: bills, supplies, birthdays, school forms, returns and credits, ranked by what is overdue or at risk.**

### Added
- `household_due` (starter tool list) and `gbrain household due` rank household records as overdue, at risk or coming up, each with a plain reason, its page slug and a proposed action. Every proposed action carries `requires_approval: true`: GBrain never buys, pays, books, calls or sends. Dates use `brain.timezone` (UTC with a notice when it is unset), and `as_of` makes a ranking reproducible.
- `household_add`, `household_mark` and `gbrain household add|mark|list|replace` write records through the normal page write path with no model call. A field that looks like a full account or card number is refused (`account_number_key`) and never echoed.
- One placement table decides each record's folder and readers. On a brain that serves several people, money, returns and anything about a child (a subject page with `household_role: child`) are readable by adults only; supplies, appointments, birthdays and deadlines by adults, helpers and family chats. A subject GBrain cannot classify keeps the record adults only, and a record whose subject was reclassified drops out of remote reads until `gbrain household replace` recomputes it.
- Guide: docs/guides/household.md.

<!-- behavior-change: household_records_gst3825 -->
