**Chronicle dates now read the same on every machine: event times print in UTC, and "today" is the UTC day.**

### Fixed
- `gbrain` chronicle reads (a day or week of the timeline, "since", "on this day" and "last seen") no longer depend on the computer's time zone. Before, a local brain on a machine outside UTC printed an event's time in the machine's zone, could list a plain note before or after an event on the same day depending on that zone, and used the machine's date as "today". Now every brain, local or on a server, prints event times in UTC (for example `2026-06-18 03:00:00+00`), lists a plain note at the start of its day in UTC, and uses the UTC date when you do not give one.

<!-- behavior-change: chronicle_day_utc_lane6 -->
