# The morning note

Every night the dream cycle learns things: facts it pulled out of your conversations, promises people made to you,
thin pages it filled in, facts that disagree, and people who may be the same person. The morning note is the short
list of what it learned, with a way to say "right" or "wrong" about each one.

## Reading it

Your agent sees one line when a session starts after a night that learned something, for example
"the brain has 7 things to show the user (2 need a yes or no)". It asks you, and if you say yes it calls the
`learned` tool. From a terminal:

```bash
gbrain learned              # what you haven't seen yet from the last 7 days, 15 at most
gbrain learned --since 2026-11-20   # everything since a date, seen or not
gbrain learned --stats      # per-night counts: shown, kept, undone, expired
```

Each item has a stable id (`[item 12]`) and a link to the page, fact or loop it came from.

## Keeping and undoing

```bash
gbrain learned-keep 12,15       # these are right
gbrain learned-keep all         # every pending change from the last 7 days is right
gbrain learned-undo 13 --reason "wrong person"
```

Keeping writes nothing to your pages; it only records your answer. Undoing reverses the change through the command
that owns it, with the same checks as running that command yourself:

| Item | What undo does |
|---|---|
| New fact | Forgets it (the fact is withdrawn; its history stays) |
| Promise made to you | Drops the open loop |
| Thin page filled in | Puts the page back to the version before it was filled in. If the page was edited since, undo refuses and prints the commands to look at its history and pick a version, so your edit is never overwritten. |
| Facts that disagree | Rejects the newer fact, so the older one stays (on the brain host; a remote agent gets the command instead) |
| Same person? | Prints `gbrain dedupe reject <group>` to run on the brain host; `gbrain dedupe confirm <group>` says they are the same |

A fact you typed into a page's Facts table is shown as "you wrote" and is never undone here: edit the page.

## What happens to items you don't answer

An item you never saw expires after 7 days. An item you saw and didn't undo counts as right in `--stats`. A
"same person?" question stays in the note until you answer it, and at most five are open at once.

## Turning the session-start line off

```bash
gbrain config set learning.note.push false
```

The note itself stays available with `gbrain learned`.

## What runs by default

Facts that disagree are found without any setup. Each dream cycle compares typed facts (a metric with a value, unit and
period) and files a "which one is right?" question when two disagree. It needs no key and changes no fact until you
answer. Turn it off with `gbrain config set dream.claim_conflicts.mode off`. A value you already set is kept.

Filling in thin pages stays off until you turn it on with `gbrain config set cycle.enrich_thin.enabled true` (it needs
a chat model key). Each cycle run then fills up to 3 thin person and company pages per source, at about $0.01 a page,
and stops at $0.50 per run. `gbrain config set cycle.enrich_thin.max_daily_cost_usd <usd>` caps a whole day.

`gbrain doctor` reports the newest run and how much of the note you kept or undid (`learning_note`).
