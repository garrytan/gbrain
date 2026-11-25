**Saving a page that has a `## Facts` or `## Takes` table now works on a Rust brain, with the same rows as on PGLite and Postgres.**

### Changed
- When you save a page whose facts or takes table changed (a cell edited, a row dropped or added, a take resolved), the steps that update the stored facts and takes are now engine calls instead of raw SQL. Postgres and PGLite send the same statements as before.
- A Rust brain runs those steps itself. Before, any save that updated a page with a facts or takes table stopped there on a Rust brain.
- Five repairs that end in such a save now finish on a Rust brain as on Postgres: `gbrain repair take-supersession`, `accepted-takes`, `redacted-facts`, `lost-fence-rows` and `split-facts`. The `unwithdrawn-facts` preview now lists the same rows there too.
- A trust tier change of one fact, take or page (`setRowTier`) reads and writes through engine calls as well.
- A take's resolved date in the table is read the way Postgres reads it ("March 1, 2026", "2026/03/01", "03/01/2026", times, `Z`, numeric offsets and zone abbreviations such as `PST` or `CET`), and also with a time zone name (`America/New_York`) or an abbreviation whose offset depends on the date (`MSK`), using the time zone rules of that date. A few rare forms (a zone followed by an offset such as `PST+1`, or a date after 2037 in a zone with daylight saving time) are not read on a Rust brain yet: the save stops there with a message that names the date, and nothing is written.
