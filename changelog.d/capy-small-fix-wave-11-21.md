**Clearer errors for bad search, timeline and import input, and honest doctor and halt reporting.**

### Fixed
- `gbrain doctor` no longer reports the quarantined pages, flagged pages and autopilot fan-out checks as passing when the check itself fails. It now shows a warning with the error, and skips quietly only when the table it reads doesn't exist yet. (#9924)
- Search reads a negative limit as the default and a negative offset as 0, instead of returning the wrong rows or failing. (#9921)
- The timeline lookup refuses a date that isn't a YYYY-MM-DD calendar date (a full timestamp included) and a negative or fractional limit with a clear invalid-input error naming the field, instead of a database error. (#9920)
- `gbrain jobs cancel --group <id> --json` exits 1 with a `not_found` error when the group has no jobs, as it already did without `--json`. A script that read the old empty success output now sees the error. (#9919)
- `gbrain access rule import --file <path>` names a missing file as invalid input and writes nothing. (#9889)
- Concept synthesis records a run stopped by a provider-wide sign-in or rate-limit failure under that reason, instead of as an ordinary item error. (#9962)

Thanks to @Masashi-Ono0611 and @Kkkkkuro for the reports.
