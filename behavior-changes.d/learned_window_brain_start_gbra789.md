---
kind: fix
---
gbrain learned and gbrain learned --stats no longer name a start date older than the brain. On a brain created minutes ago they used to say "Nothing new learned since" a date seven (or thirty) days back; the default window now starts when the brain was created (its earliest source) when the brain is younger than the window. The since field in --json moves the same way. An explicit --since is unchanged.
