**`gbrain repair visibility --propose` drafts who should read each open page, so a brain shared by several people can be labelled without typing every reader list by hand.** It reads the participants, attendees and to, from and cc addresses already on open pages, matches each address to an enabled member's declared email, and groups the pages by reader set with the owner always first. For each set it writes a private slugs file (mode 0600) and prints the existing `gbrain repair visibility --slugs-file ... --readers ...` command, so you preview and apply with the tools you already have. It labels nothing itself. A page with an address that matches no member, or a slug a slugs file cannot carry (one starting with `#`, padded with spaces or holding a line break), is listed as unmatched instead of guessed. DM, chat and mail folders with no address list get an `access rule add` command to fill in. On a brain that serves one person it says there is nothing to propose and reads no pages. It works the same on a repo-less brain and a git brain, and refuses to write its files inside a git work tree.

### Itemized changes

- `src/commands/repair-propose.ts` (new): builds the proposal, writes each slugs file through an exclusive temp file and a rename, and shell-quotes every printed command.
- `src/commands/repair.ts`: new `--propose` and `--out` flags on `gbrain repair visibility`.
- `src/core/access/open-pages.ts`, `src/commands/access-serves.ts`: share the open-page query and git-root lookup with the new command.
- New error code `repair_propose_dir_in_git`, listed in `docs/guides/error-codes.md`.
- Docs: `docs/guides/repair.md` (proposing readers) and `docs/architecture/key-files/access.md`.
- Tests: new `test/repair-visibility-propose-gst2670.test.ts` (PGLite and Postgres).
