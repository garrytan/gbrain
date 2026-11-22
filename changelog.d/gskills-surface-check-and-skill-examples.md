**The skill resolver's commands, flags, config keys and `--json` output fields are now part of what stable promises to keep, and six bundled skills use generic examples.**

### Changed
- `docs/contracts/public-surface.json`, which `bun run check:public-surface` compares on every pull request, now lists the `gbrain skills index` (`build`, `status`, `remove`), `resolve`, `library` and `pin` subcommands with all their flags, `gbrain skillpack health` and `doctor`, `gbrain setup --skill-loading`, the config keys `skills.resolver.top_k`, `top_gate`, `pinned`, `pins.<catalog>`, `session_token_budget` and `per_harness.<harness>.dirs`, and the `block`, `no_skill` and `suggestions[].id` fields of `gbrain skills resolve --json`. Tools built on the resolver can rely on them, because removing one now needs a deprecation announced at least 14 days ahead.
- A deprecation record for a command now also covers that command's subcommands, as it already covered its flags.
- The archive-crawler, cron-scheduler, reports and strategic-reading skills, and the schema-unify and skillpack-harvest skills, no longer carry examples tied to one particular deployment or person; the instructions are otherwise unchanged.
- The voice-note-ingest skill's example of a verbatim quote no longer contains profanity, and book-mirror now keeps verbatim quotes to a sentence or two instead of whole passages.
