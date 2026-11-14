**Guest notes: a group member's note is saved, marked as a guest's, warned about on every read, and becomes your own page only when you say so.** People in a group chat with your agent sometimes say things worth keeping. A guest source keeps those notes apart from your own pages, with a record of who said them. Nothing changes until you run `gbrain guests init`: a brain without a guest source reads, writes and costs exactly as before, and no grant, privacy label or search scope changes on upgrade.

A guest source has four rules the database enforces, whatever program writes. Only writers on the source's list (an OAuth client or legacy token, for example the broker your agent's host runs) may create a page there or change its text, and only as a new page; your own CLI, `gbrain import`, sync, `remember`, `add_link` and `put_raw_data` are refused `source_writer_restricted`, while delete, restore and purge from your CLI still work. No page there is ever stored above the `external_untrusted` trust tier, even after an owner rewrite or a trust confirmation. Guest notes feed no facts, takes, timeline entries or links (`guest_page_immutable`). And a guest source is database-only, so attaching a local path is refused. `gbrain guests init` also refuses an existing source that already holds pages, deleted pages not yet purged included, so your own pages never turn into guest notes.

When the writer saves a note, gbrain records who it was saved for, which group, when and which client sent it, in its own table that no later write can edit and that never comes from the page text. Every read that returns a guest note (search, query, get, list, find, backlinks, timeline, think and the rest) marks it as an outside guest's words: `origin: "guest"` and a `guest` object in JSON, and a warning line plus the external-data envelope in text. A contract test fails if any operation, present or future, returns a guest row without the mark.

You keep a note as your own page with `gbrain guests promote <slug>` (MCP `promote_guest_note`, owner only; anyone else is refused `guest_promotion_owner_only`), which writes a normal page and records the link; the broker can no longer delete a promoted note (`guest_page_promoted`). Promotion reads the note through the caller's normal read scope, and promoting again finishes a promotion whose link was not recorded (an interrupted run or a write still pending) without writing the page twice. Your own tokens and OAuth clients read the guest source only once it is on their read list: `gbrain guests grant-owner-clients` previews that and `--yes` applies it. `gbrain doctor --only guest_source` checks the whole setup, including that the source's two records agree.

### Added
- `gbrain guests init --writer <principal>` (preview, then `--yes`) creates or marks the `guests` source; `gbrain sources writers <id> [--add|--remove|--clear]` changes who may write.
- `gbrain guests promote <slug>` and MCP `promote_guest_note`: the owner keeps a guest note as their own page.
- `gbrain guests grant-owner-clients`: adds the guest source to the owner's own clients' read lists, preview first.
- Doctor check `guest_source`.
- Error codes `source_writer_restricted`, `guest_page_immutable`, `guest_promotion_owner_only`, `guest_page_promoted` and their recovery paths (docs/guides/error-codes.md, docs/guides/write-refusals.md).
- Guide: docs/guides/guest-notes.md.

### Itemized changes
- The guest-notes schema migration (`src/core/schema-migrations/v<NNN>-guest-notes.ts`; `GUEST_NOTES_MIGRATION` in `src/core/guests/migration.ts` names its number): the `guest_sources`, `guest_marks` and `guest_promotions` tables under row-level security, the per-source trust ceiling in the trust trigger, and the writer backstop trigger.
- `src/core/guests/`: admission (writer list, new-page-only, allowed frontmatter and readers), the mark and its warning, derived-row refusals, promotion, owner credentials and source setup.
- Read paths (`src/cli/page-render.ts`, `src/cli/search-row-format.ts`, `src/cli/guest-lines.ts`, `src/core/access/page-items.ts`, `src/core/think/index.ts`, `src/core/search/transcript-quote.ts`) carry the guest mark and warning.
- A guest writer can delete only the guest notes it saved itself; deleting a note another writer saved is refused `permission_denied`.
- Stale extraction, `propose_takes` (scoped or not) and the cycle's fact, atom and enrichment phases leave guest pages out.
- Reads on a brain whose schema is still behind that migration keep working, because the guest check falls back to the source config when the `guest_sources` table is missing.
- Goldens regenerated: `test/fixtures/goldens/sql-text/pages.json` (stale-extraction query excludes guest pages), `test/fixtures/goldens/exports/types.json` (guest types and error codes), the doctor goldens (the `guest_source` row and the three new tables under row-level security) and `test/fixtures/goldens/cli/tools-json.json` (the new operation).

<!-- behavior-change: guest_notes_gbra504 -->
