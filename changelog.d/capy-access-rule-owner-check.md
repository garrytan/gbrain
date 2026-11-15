**`gbrain access rule add` no longer lets a hand-typed reader list lock the brain owner out of a folder.** When an owner is set, a rule whose `--readers` leaves the owner out is refused with `readers_omit_owner`, the same check and message `gbrain repair visibility --readers` already uses, and nothing is written. Pass `--allow-without-owner` when the owner really should not read it. A brain with no owner set is unchanged, and it works the same on a repo-less source (rules in the database) and a git source (`.gbrain/access.yml`).

<!-- behavior-change: access_rule_keeps_owner_gst2698 -->

### Itemized changes

- `src/commands/access-rules.ts`: `rule add` checks the owner before previewing or writing; new `--allow-without-owner` flag, named in `gbrain access --help`.
- `src/core/access/owner.ts`: the owner lookup and the `readers_omit_owner` error now live here and are shared with `src/core/repair/readers.ts`.
- Docs: `docs/guides/access-designations.md` and the setup skill name the flag.
- Tests: new `test/access-rule-owner-gst2698.test.ts` (refusal, override and no-owner case on a repo-less and a git source, PGLite and Postgres); two existing tests that rule a page away from the owner on purpose now pass `--allow-without-owner`.
