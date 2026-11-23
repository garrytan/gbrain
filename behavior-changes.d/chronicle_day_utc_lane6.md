---
kind: fix
---
Chronicle reads (a day or week of the timeline, since, on this day and last seen) now use UTC on every engine and every machine. A local brain on a computer outside UTC used to print event times in that computer's time zone, start a plain note's day at local midnight and take the local date as today. It now prints event times in UTC, starts a plain note's day at UTC midnight and takes the UTC date as today, so a local brain and a Postgres brain give the same answer. On a computer outside UTC, an event near midnight can now show under the neighbouring day; pass an explicit date to read a specific UTC day.
