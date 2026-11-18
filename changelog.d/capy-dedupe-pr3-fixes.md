**Three fixes for duplicate-people decisions: `confirm --join` on an already confirmed group, a sync that could write an older decision back, and a doctor fix that never cleared.**

### Fixed
- `gbrain dedupe confirm <group-id> --join <entity>` no longer crashes with a TypeError when the group is already confirmed and the joined identity holds two pages recorded as different people. It says the group is already confirmed and writes nothing.
- A sync that read the duplicate decisions before a newer `confirm` or `reject` was committed no longer writes the older verdict back into the database. Decisions are applied one at a time, and a sync whose read is out of date reads again.
- `gbrain doctor` offers `gbrain dedupe reconcile` only when reconcile can clear what it found. A confirmed group with a missing page, a page that sits in another identity group, or a decision file that does not validate now gets its own remedy (restore the page, `gbrain dedupe reject`, `gbrain entity-identity-unlink`, or fix the file), instead of a reconcile that leaves the warning in place.
