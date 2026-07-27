# Compact-format resolver (test fixture)

Tests v0.41.7.0 list-format parser. Skills use clearly-fictional names
so they don't shadow real bundled skills.

## Always-on
- **brain-search**: search my brain | what do we know about | find references to

## Personal
- **gift-advisor**: gift idea | what should I bring | birthday gift | housewarming
- **flight-tracker**: track my flight | flight status | when does my flight land

## Email + Calendar
- **email-triage**: triage email | sort my inbox | morning email
- **meeting-prep**: prep for my meeting | meeting in 30 min | get ready for the call
- **calendar-prep**: what's on my calendar | tomorrow's schedule
- **daily-digest**: morning brief | end of day summary

## Workflows
- **investor-update-ingest**: investor update | portfolio update | company metrics
- **content-creation**: draft a tweet | write a post | new article
- **executive-assistant**: schedule a meeting | block time | reschedule

## Notes
The bullets below are prose, not skill rows. The v0.41.7.0 parser
rejects them via the kebab-lowercase name regex. If you see entries
materialize for any of these, the D4 regex tighten regressed.

- **Note**: this is a prose bullet (capitalized name, must be skipped)
- **Convention**: see [parent docs] (capitalized name, must be skipped)
- **TODO**: nothing here is a real skill row (capitalized, skipped)
- **Important**: this is just a callout (capitalized, skipped)
