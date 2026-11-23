**The github, google, meetings, slack and imessage connectors record their last sync time and newest content time through one typed engine call, which a Rust brain also serves.**

### Changed
- A connector's clean run now records the source's last sync time and the time of its newest content through `markSourceSynced` instead of raw SQL. A run that saw nothing newer keeps the newest content time it had, as before.
- `markSourceSynced` takes a newest content time, so the managed connector sync can switch to it in a later change.
- A meetings sync finds a meeting's existing page through the typed `readMeetingPage` engine call, and reads its source row through `readSourceState`, instead of raw SQL. PGLite and Postgres send the same statement as before, and a Rust brain answers it where before it refused.
- Saving a meeting page with attendees resolves each attendee through the typed `listAttendanceMatches` engine call instead of raw SQL: by slug, by title or by alias, ignoring case, and only when exactly one person page matches. PGLite and Postgres send the same statement as before, and a Rust brain answers it where before it refused.
