**Twelve small fixes from outside reports: doctor, schema, dream, search diagnose, Slack sync and error messages now say what is true and point at commands that work.**

### Fixed
- The schema-pack advisor suggests `gbrain schema list` for a pack it cannot resolve; it used to suggest `gbrain schema packs`, which does not exist (#10307).
- `gbrain schema active` refuses a configured pack that is not installed with `invalid_params` and a `gbrain schema list` fix, instead of an internal error that pointed back at doctor (#10201).
- Capture accepts a page type the active schema pack declares as an alias, as `gbrain schema lint` already does (#10103).
- Doctor `fact_bulk_dates` no longer states that a day holding many facts records when they were loaded: same-day events look the same, and only a claim with an earlier date contradicts the stored date (#10275).
- Doctor `minions_migration` says its dry-run preview never clears the warning, names `gbrain sources shared-skills <source> off` for a source that should not take shared skills, and says the real `gbrain apply-migrations --yes` run clears it (#10040).
- Doctor `unlinked_facts` names the real `gbrain facts relink --conversation` command instead of its dry run, which records nothing and so never moved the warning (#10039).
- Doctor `extract_health` counts a halt's age in UTC days, the calendar the extractor writes, so a database in another time zone no longer shows today's halt as a day old (#10356).
- `gbrain search diagnose` reports `source_id: null` and "every source" when no `--source` filter was given, instead of claiming `default` (#10314).
- `gbrain dream --input` is a usage error when the value is missing or an explicit `--phase` list leaves out `synthesize`; the file used to be ignored silently (#10318).
- A Slack sync names users first seen on a later day of the same run from that run's one `users.list` call, instead of writing their raw ids (#10220).
- An interrupted PostgreSQL data-file read (`Interrupted system call`) is reported as `storage_interrupted` with host-side advice, not as damaged data with a repair command (#10351).
- The `cloudflare_attention_required` junk pattern matches the interstitial's title or heading, not prose that quotes the error line, so such pages are no longer quarantined (#9868).
