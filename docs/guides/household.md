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
subject is classified. You can narrow a shared record with `--audience adults`; nothing widens a record past the table.

On a brain that serves one person, records carry no reader list and you read everything. On a brain that serves several
people, each record names the owner and the `household-adults`, `household-helpers` and `household-chats` groups
its row allows. To reclassify a subject, run `gbrain household replace --about <slug> --role <role>` on the brain host
(or `household add --child` with a new record): it narrows the records about the subject to adults first, then sets
the role. An edit or sync that narrows a subject while records about it are still shared is refused
([household_reclassify](#household_reclassify)), and only the owner can turn a child into another role.
`gbrain household replace` with no `--about` recomputes every record's readers, for example when the brain starts
serving several people.

## household_exists

`household_add` refused because a record with that slug already exists. Mark the existing record instead
(`gbrain household mark <slug> <event>`), or pass `--slug` with a different name if it really is a second record.

## household_scale

`household_due` found more household records than it reads in one call (2,000), so it returned nothing rather than a
partial ranking. Narrow the read with `kinds`, `about`, `handled_by` or `source_id`, and archive records you no
longer need (`gbrain household mark <slug> archive`).

## household_reclassify

A write changed a subject page's `household_role` in a way that would leave household records readable by people the
table no longer allows, so nothing was written. Two cases: a remote agent tried to take a child out of `household_role: child`
(changing or removing it), or to give a subject a role that would widen records already kept to adults because of it
(only the owner can), or the subject was narrowed (made a child, or its role removed) while records about it were still shared
with helpers. Run `gbrain household replace --about <slug> --role <role>` on the brain host: it narrows those records
to adults (`audience: adults` on each) and then sets the role. To remove a role, run it without `--role`, then edit
the page again.

## household_transition

A write tried to move a record's status in a way households do not allow, so nothing was saved. An archived record
is final, a paused record is resumed before it can be done, and a done record can only be archived. Record what
happened with `gbrain household mark <slug> <event>` (it keeps the event in the record's timeline), or add a new record
when the old one is archived. This applies to every write, `put_page` and `edit_page` included.

## account_number_key

A field looked like a full account, card or routing number, so nothing was saved and the value is not repeated back.
Leave the number out (the last four digits in a title are fine) and keep it in your bank or password manager.
