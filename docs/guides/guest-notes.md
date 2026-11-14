# Guest notes

People in a group chat with your agent sometimes say things worth keeping ("the
offsite moved to Friday"). Those people are outside guests: they aren't you, and
their words shouldn't read as yours. A **guest source** is where gbrain keeps
their notes, apart from your own pages, with a record of who said what.

This page is the operator view: what a guest source is and how to set one up.
Saving notes into it, the warning every read shows on a guest note, and keeping a
guest note as your own page arrive in later releases. Until then a guest source
holds nothing unless a listed writer puts pages there.

## What a guest source is

A guest source is a normal gbrain source with four rules the database itself
enforces, whatever program writes to it:

- **Only listed writers.** Creating a page there, or changing its text, title,
  frontmatter, slug or source, needs a writer on the source's writer list. A
  writer is named the way gbrain records who made a write: `oauth_client:<client
  id>` for an OAuth client, `legacy_token:<token id>` for a legacy token. Your own
  CLI is not on the list, so `gbrain put --source guests` is refused with
  `source_writer_restricted`. Soft delete, restore, purge and maintenance that
  touches no page text still work for you.
- **Never above external, untrusted.** Every page there is stored at the
  `external_untrusted` trust tier or lower ([memory trust](memory-trust.md)), even
  when a write path would normally raise it (an owner rewrite, a backfill, a
  trust confirmation).
- **No facts, takes or timeline entries.** Those rows are refused in a guest
  source (`guest_page_immutable`), so a guest's words never turn into facts about
  people in your brain.
- **Database-only.** A guest source has no local folder or git repository: the
  database is the record, as on any repo-less brain. Attaching a path
  (`gbrain sources set-path`, `gbrain sources add <id> --path`) is refused, and a
  source that already has a path can't become a guest source.

A guest source is also federated, so your own searches include it. Brains
without a guest source are unchanged.

## Set one up

Preview first. Nothing is written without `--yes`:

```bash
gbrain guests init --writer oauth_client:client-a
```

```text
Preview: gbrain guests init (nothing written; run again with --yes to apply)
  Source "guests": will be created, database-only (no local path) and federated.
  Trust ceiling: external_untrusted (no page there is ever stored above it).
  Writers: oauth_client:client-a
```

Then apply it:

```bash
gbrain guests init --writer oauth_client:client-a --yes
```

The source is called `guests` unless you pass `--source <id>`. Running init
again on a guest source adds the new writers and keeps the old ones. If the
source exists already, it must have no local path; init then marks it as a guest
source.

## Change who may write

```bash
gbrain sources writers guests                                   # list
gbrain sources writers guests --add oauth_client:client-b       # add
gbrain sources writers guests --remove oauth_client:client-a    # remove
gbrain sources writers guests --clear                           # nobody
gbrain sources writers guests --json
```

A source that isn't a guest source has no writer list, so the command refuses
it. Changing the list is your decision on the brain host; nothing in gbrain
widens it on its own.

## What is stored

Three database tables back a guest source. `guest_sources` names each guest
source, its writer list and its trust ceiling. `guest_marks` will hold, for each
guest note, who it was saved for, from which group (for example `group:team-a`),
the sender's label (for example `bob-example`), when and by which writer; a mark
can never be edited and is removed only when its page is purged.
`guest_promotions` will record guest notes you keep as your own pages. In this
release nothing writes the last two yet.
