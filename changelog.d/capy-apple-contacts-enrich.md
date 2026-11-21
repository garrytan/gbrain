**Apple Contacts can now fill themselves in from your brain, adding only and off until you switch it on.**

### Added
- After each clean pull, `apple_contacts.enrich` (off by default; `dry_run` records the batch without sending it) fills empty companies and job titles from the one person page a card is linked to, adds emails and phones you confirmed (your Google Contacts entry for that card, or a fact you stated), and creates at most 10 cards a run for Google Contacts entries that match exactly one person page. It never changes, removes, deletes or merges anything, and uses no outside service. Sending also needs `apple_contacts.write` on and the helper's enrich token in `apple_contacts.write_token_file`.
- `gbrain apple-contacts enrich status` shows the last run, change by change with the page each value came from, and `gbrain apple-contacts enrich dry-run` lists what the next run would send.
