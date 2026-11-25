# Household records

GBrain can keep track of the things a home runs on: bills, supplies that run out, birthdays, school forms,
appointments, returns and store credits. Ask `household_due` (or run `gbrain household due`) and it tells you what is
overdue, at risk or coming up, ranked, each with a plain reason and a proposed next step.

GBrain never acts on its own. It never buys, pays, books, calls or sends. Every proposed step carries
`requires_approval: true`, so your agent asks you first. If a spending policy is set up, its advice appears next to
the proposal in `policy_advice`; it never switches the approval off.

Everything here works on a keyless brain with no git repository. No household call makes a model call.

## Records versus tasks

A household record is something that comes back or has a date the house cares about: the water bill every month,
coffee beans every two weeks, a birthday every year, a form due Friday. Put one-off to-dos that belong to a project
(a renovation plan, a trip) on that project's page or in your task tool instead. A rule of thumb: if missing it
costs money, a late fee or a hurt feeling, and it has a date or a rhythm, it is a household record.

## Adding records

```bash
gbrain household add bill --title "Water" --due 2026-12-03 --recurs monthly --amount 60 USD
gbrain household add supply --title "Coffee beans" --cadence 14d --last-done 2026-11-20
gbrain household add birthday --title "Alice birthday" --on 03-14 --about people/alice-example --about-role adult
gbrain household add deadline --title "Field trip form" --due 2026-12-02 --school --about people/robin-example --child
```

Kinds: `bill`, `supply`, `birthday`, `deadline`, `appointment`, `return`, `credit`. Dates are strict
`YYYY-MM-DD` (birthdays take `MM-DD`); a cadence is a number and a unit (`14d`, `2w`, `6m`, `1y`).
Agents call the `household_add` tool with the same fields.

## Marking what happened

```bash
gbrain household mark household/money/bill/water paid --on 2026-12-02
gbrain household mark household/supplies/coffee-beans bought
```

Events by kind: bills take `paid`, supplies `bought`, appointments `booked`, deadlines `submitted`, returns
`returned`, credits `used`, and birthdays `gift_ideas`, `gift_bought` and `given`. `done` and `skip` work on the dated
kinds, and `pause`, `resume` and `archive` on every record. A paid monthly bill moves to its next month; a bought supply
starts its cadence again.

## Who can read what

Each record's readers come from one placement table, recomputed on every write:

| Records | Folder | Read by |
|---|---|---|
| Bills and credits | `household/money/` | adults only |
| Returns | `household/returns/` | adults only |
| Supplies, appointments, birthdays, deadlines | `household/supplies/`, `household/appointments/`, `household/birthdays/`, `household/deadlines/` or `household/school/` | adults, helpers and family chats |
| Anything about a child | `household/kids/` | adults only |

A child is a subject page with `household_role: child` (`--child` on `household add` writes it). A subject GBrain
cannot classify (no page, or no `household_role`) is treated as private: the record stays adults only until the
subject is classified. You can narrow a shared record with `--audience adults`, or by writing your own `readable_by`
on it: GBrain keeps the readers you name that the table allows (on a brain that serves one person, exactly as you
wrote them). Nothing widens a record past the table. A record is a page with `type: household`; a page that only
sits in a `household/` folder is not one.

On a brain that serves one person, records carry no reader list and you read everything. On a brain that serves several
people, each record names the owner and the `household-adults`, `household-helpers` and `household-chats` groups
its row allows. To reclassify a subject, run `gbrain household replace --about <slug> --role <role>` on the brain host
(or `household add --child` with a new record): it narrows the records about the subject to adults first, then sets
the role. On a brain that serves several people, only the owner's MCP connection can make a subject a child with
`household_add` or `put_page`, or remove a subject's role; any other connection is refused with `household_reclassify`, the same way whatever records exist, so the refusal says nothing about records it cannot read. An edit or sync that narrows a subject while records about it are still shared is refused
([household_reclassify](#household_reclassify)), and so is making a child of a subject page that sync deleted and
wrote again; only the owner can turn a child into another role.
Every write path runs these checks against the stored page and the new one: `put_page`, `edit_page`, the household
tools, sync and imports (a household page too large for the streamed import is held), and `delete_page`. A remote
agent cannot widen a record: it cannot change its type, drop a child from its `about`, remove `audience: adults`,
change it to a shared kind, or widen its `readable_by`. It also cannot delete a subject that records are about.
`gbrain household replace` with no `--about` recomputes every record's readers, archived records included and however
many there are, for example when the brain starts
serving several people. Run it right after you add the second person: until it runs, records written while the brain
served one person carry no reader list. `household_due` leaves them out for remote callers and says so
(`household_placement_stale`), but a direct page read still returns them, and making a subject a child counts them as
shared with helpers, so it is refused until the replace runs.

## Check it across harnesses

The household tools are meant to give every agent the same answer. `test/e2e/household-cross-harness-real.serial.test.ts`
checks that with real agents on a keyless brain with no git repository, seeded with an invented household
(`bun scripts/synthetic-household.ts <dir>` seeds one for you to try):

1. Claude Code, with gbrain connected, adds a gas bill and marks the milk bought.
2. A new Codex session, with gbrain connected, answers "what's at risk at home this week?" through `household_due`.
   Its list has to match a ranking worked out by hand, in order, with each item's page slug.
3. The same two steps run again with gbrain disconnected, using only each tool's own notes file (`AGENTS.md`). That
   answer has to miss at least one item, which shows the brain is what got the list right.

It costs a few dollars of model use, so it runs only when you ask:
`GBRAIN_TEST_HOUSEHOLD_LIVE=1 GBRAIN_TEST_KEEP_PROVIDER_KEYS=1 bun test test/e2e/household-cross-harness-real.serial.test.ts`,
with the `claude` (2.1.280 or newer, for Opus 5.5) and `codex` commands, and `ANTHROPIC_API_KEY` plus `CODEX_API_KEY`
or `OPENAI_API_KEY`. If you ask for it and something is missing, it fails and names what. It uses no judge and publishes
no number. The seed script refuses a directory that already holds a brain.

## household_exists

`household_add` refused because a record with that slug already exists. Mark the existing record instead
(`gbrain household mark <slug> <event>`), or pass `--slug` with a different name if it really is a second record.

## household_scale

`household_due` found more household records than it reads in one call (2,000), so it returned nothing rather than a
partial ranking. Archived records and records your filters leave out do not count toward the 2,000. Narrow the read with `kinds`, `about`, `handled_by` or `source_id`, and archive records you no
longer need (`gbrain household mark <slug> archive`).

## household_reclassify

A write or delete would have let more people read household records than the placement table allows, so nothing was
written. For a record: a remote agent tried to change its type, drop a child from its `about`, remove
`audience: adults`, change it to a shared kind or widen its `readable_by`. Keep those fields as stored, or ask the
brain's owner, who can make the change with a local write. For a subject page: a remote agent tried to take a child out of `household_role: child`
(changing or removing it), or to give a subject a role that would widen records already kept to adults because of it
(only the owner can), or the subject was narrowed (made a child, or its role removed) while records about it were still shared
with helpers. Run `gbrain household replace --about <slug> --role <role>` on the brain host: it narrows those records
to adults (`audience: adults` on each) and then sets the role. To remove a role, run it without `--role`, then edit
the page again. A subject that records are about can be deleted only on the brain host, and only once no record
about it is still shared with helpers (run `gbrain household replace --about <slug>` first).

## household_transition

A write tried to move a record's status in a way households do not allow, so nothing was saved. An archived record
is final, a paused record is resumed before it can be done, and a done record can only be archived. Record what
happened with `gbrain household mark <slug> <event>` (it keeps the event in the record's timeline), or add a new record
when the old one is archived. This applies to every write, `put_page` and `edit_page` included.

## account_number_key

A field, the body or the timeline of a household record looked like a full account, card or routing number (on any
write: the household tools, `put_page`, `edit_page` or sync), so nothing was saved and the value is not repeated back.
Leave the number out (the last four digits in a title are fine) and keep it in your bank or password manager.
A frontmatter key shaped like a number counts too, and its name is not repeated back either. Calendar dates and date
ranges (`2026-12-03 - 2027-01-03`) are never read as numbers. Keys named `account`, `acct`, `iban` or `routing`
count on their own; a plain `bank` or `card` key only counts when it names the number (`card_number`, `bank_no`).
