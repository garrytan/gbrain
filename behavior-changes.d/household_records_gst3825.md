---
kind: add
---
GBrain now keeps household records: bills, supplies, birthdays, school deadlines, appointments, returns and store credits, as pages of type household. `household_due` (on the starter tool list, and `gbrain household due`) ranks what is overdue, at risk or coming up, each with a reason and a proposed action that always needs the user's yes; `household_add` and `household_mark` (and `gbrain household add|mark|list`) write them. On a brain that serves several people, each record's readers are recomputed from the placement table on every write: money, returns and anything about a child are adults only, and a record about a subject GBrain cannot classify stays adults only. GBrain never buys, pays, books, calls or sends. Guide: docs/guides/household.md.
