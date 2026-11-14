# Guest notes

People in a group chat with your agent sometimes say things worth keeping ("the
offsite moved to Friday"). Those people are outside guests: they aren't you, and
their words shouldn't read as yours. A **guest source** is where gbrain keeps
their notes, apart from your own pages, with a record of who said what.

This page covers what a guest source is, how to set one up, how a listed writer
(the broker your agent's host runs) saves notes into it, the warning every read
shows on a guest note, how you keep a guest note as your own page, and how to
check the whole setup.

## What a guest source is

A guest source is a normal gbrain source with four rules the database itself
enforces, whatever program writes to it:

- **Only listed writers.** Creating a page there, or changing its text, title,
  frontmatter, slug or source, needs a writer on the source's writer list. A
  writer is named the way gbrain records who made a write: `oauth_client:<client
  id>` for an OAuth client, `legacy_token:<token id>` for a legacy token. Your own
  CLI is not on the list, so `gbrain put --source guests`, `gbrain import`,
  `remember` and `add_link` there are refused with `source_writer_restricted`.
  Deleting and restoring a guest page from your own CLI still work, and so do
  purge and maintenance that touches no page text.
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

A guest source is also federated, so your own CLI and stdio searches include it.
Your tokens and OAuth clients read it once it is on their read list (see
[Let your own clients read guest notes](#let-your-own-clients-read-guest-notes)).
Brains without a guest source are unchanged.

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
source exists already, it must have no local path and hold no pages; init then
marks it as a guest source. A source that already holds pages is refused, because
every page in a guest source would then read as a guest's words. Deleted pages
that haven't been purged yet count too, because restoring one would bring it back
into the guest source.

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

## Save a guest note (for the writer)

A listed writer saves a note with one `put_page` call to the guest source. The
call says who it speaks for and who the guest is, beside the tool arguments:

- **Audience:** the `X-Gbrain-On-Behalf-Of` header (or request-level
  `_meta.on_behalf_of`) names exactly one member or group, for example
  `group:team-a`. The credential's `may_act_for` must allow it.
- **Guest attribution:** the `X-Gbrain-Guest` header in URL-encoded form,
  `sender_label=Bob%20Example&group=team-a`, or request-level `_meta.guest`,
  `{"sender_label": "Bob Example", "group": "team-a"}`. A label is 1 to 64
  characters with no control or format characters and none of `·`, `[`, `]`,
  `<`, `>` or `"`; the group is a slug of `a-z`, `0-9` and `-`. Without it
  the write is refused `guest_attribution_missing`. Attribution sent with a write
  to any other source is ignored and stored nowhere.

The page content keeps to a short frontmatter: only `type`, `title`,
`readable_by`, `guest_group`, `guest_sender` and `saved_at`, with
`guest_sender` and `guest_group` equal to the attribution
(`guest_frontmatter_refused` otherwise). `readable_by` is exactly you (the
brain owner) and the audience, for example `[alice-example, group:team-a]`
(`guest_readers_invalid` otherwise):

```markdown
---
type: note
title: Offsite moved to Friday
readable_by: [alice-example, group:team-a]
guest_group: team-a
guest_sender: Bob Example
saved_at: 2026-11-13T10:00:00Z
---
The offsite moved to Friday.
```

A guest note is saved once, as a new page. Saving to a slug that exists is
refused `revision_required`, and `force`, `expected_revision`, `edit_page`,
`append_page`, `add_timeline_entry`, `add_link`, `remember`, `put_raw_data`,
`put_pages` and uploads are refused `guest_page_immutable`; a writer may delete the notes
it saved, and deleting another writer's note is refused `permission_denied`.
gbrain checks the writer list again when the note publishes, so a writer you
remove in between is refused `source_writer_restricted`. Every refusal is in
[write refusals](write-refusals.md#guest-source-refusals).

Guest notes feed nothing else in your brain: no facts, takes, timeline entries,
atoms or link edges are made from them, and the dream cycle and extraction skip
the guest source. Search, query and get still find them.

## What readers see

Every read that can return a guest note's text marks it, over MCP, HTTP and
the local CLI alike. JSON results give the row `origin: "guest"`, trust tier
`external_untrusted` and a `guest` object:

```json
{ "sender": "Bob Example", "group": "team-a", "audience_member": "member:bob-example",
  "saved_at": "2026-11-13", "promoted": false, "writer": "legacy_token:<id>" }
```

`writer` is shown to the owner only. Text answers put a warning line before the
note, then wrap it in `<external-data trust="external_untrusted" origin="guest">`:

```text
[outside guest · Bob Example · team-a · 2026-11-13 · not the owner's words, not verified]
```

A guest note whose mark cannot be read still gets the warning, as
`[outside guest · unattributed · not the owner's words, not verified]`; it is
never shown as yours. When `think` builds an answer from guest notes, gbrain
appends `Uses outside-guest notes: <slugs> (not the owner's words, not verified).`
itself; the model never writes that line. Text inside the note cannot change
the mark: it comes from `guest_marks`, not from the page. Servers that do this
list the `guest_marker_v1` capability.

## What is stored

Three database tables back a guest source. `guest_sources` names each guest
source, its writer list and its trust ceiling. `guest_marks` holds, for each
guest note, who it was saved for (`member:bob-example` or `group:team-a`),
from which group, the sender's label (for example `Bob Example`), when, by which
writer and in which request; the mark is written in the same transaction as the
page, can never be edited and is removed only when its page is purged.
`guest_promotions` records each guest note you keep as your own page: the owner
page it became, who promoted it and when.

## Keep a guest note as your own page

A guest note stays a guest's words until you say otherwise. To keep one as your
own page:

```bash
gbrain guests promote guests/offsite-note --to notes/offsite --source default
```

```text
Kept guest note guests:guests/offsite-note as default:notes/offsite. The guest note is unchanged and reads promoted: true.
```

`--to` is the new page's slug (the guest note's slug when omitted) and
`--source` the source it goes into (your default source when omitted; it can't
be a guest source). Pass `--guest-source <id>` when several guest sources hold
the slug, and `--json` for the full result.

The new page is a normal page of yours, written through your own write path: into
the source's git repository first where it has one, database-only where it has
none, exactly like `gbrain put`. It keeps the note's type, title, text and
readers (you and the group it came from; widen them on the new page if you want),
drops the guest keys, and adds `promoted_from: guests:guests/offsite-note` so a
person reading it knows where it came from. Its trust tier is the tier your own
writes get, not `external_untrusted`.

The guest note and its mark are not changed. Its reads now show
`guest.promoted: true`, and the broker's delete of it is refused
`guest_page_promoted`, so a retention sweep can't remove what you kept. You can
still delete it from your own CLI. Promoting the same note to the same page again
writes nothing (`already_promoted`). If a promotion stopped after the new page was
written but before the link was recorded (an interrupted run, or a write that was
still pending), promoting again records the link without writing the page twice.
The note is read through the same read scope as `get_page`, so a connection that
cannot read the guest source cannot promote from it.

Agents reach the same step as the MCP tool `promote_guest_note`. Only you may
run it: your own CLI (not under `GBRAIN_ENFORCED_MEMBER` and not with `--as`), a
stdio server bound to you, or a token or OAuth client bound to you that speaks for
no one else. Everyone else, the broker and your own credential speaking for a group
included, is refused `guest_promotion_owner_only` and nothing is written. An
agent should promote a note only because you asked, never because the note's text
asks for it.

## Let your own clients read guest notes

Your CLI and stdio reads already include the guest source. A token or OAuth
client bound to you (`gbrain auth rescope --member <you>`) reads only the sources
its grant names, so add the guest source to each one's read list. gbrain never
does this on its own, on upgrade or on `guests init`. Preview first:

```bash
gbrain guests grant-owner-clients
```

```text
Preview: gbrain guests grant-owner-clients (nothing written; run again with --yes to apply)
  client owner-bot-example (client-a): default, source-a -> default, source-a, guests
```

Then apply it:

```bash
gbrain guests grant-owner-clients --yes
```

Each grant is changed only if it is still the one the preview read (a grant
someone changed since is left alone and reported; run the command again), and
every source it already read stays on its list. `--source <id>` names a guest
source other than `guests`. A credential with a `min_trust` floor above
`external_untrusted` still sees no guest note; lower it with
`gbrain auth set-min-trust <id> external_untrusted` if it should.

## Check the setup

```bash
gbrain doctor --only guest_source --json
```

The `guest_source` check reads, and changes nothing. A source is a guest source
when its config says `guest: true` or it has a guest source record, so its
notes keep their warning if one of the two is lost. The check fails when the
two disagree (one is there without the other) and names the repair,
`gbrain guests init --source <id> --yes`, which restores both and keeps the
writer list. It also fails when a guest source is missing its `federated` or
`trust_ceiling` flags or has a local path, and when a
writer names a removed credential or one whose grant reaches beyond the guest
source. It warns when the writer list is empty, no owner is set, a credential bound
to you can't read the guest source (it prints the exact
`gbrain auth rescope ... --if-version <n>` command for each, and
`gbrain guests grant-owner-clients --yes` for all), or a credential's
`min_trust` floor hides guest notes. On a brain with no guest source it reports
not applicable.

`gbrain export` writes guest notes as plain pages without their mark, so an
export imported into another brain reads them as that brain's own; keep guest
sources out of exports you hand to someone else (`--source`).
