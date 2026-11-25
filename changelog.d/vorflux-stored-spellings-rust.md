**On a Rust brain, a read of a page stored under an older spelling of its name now finds the page, as it does on Postgres and PGLite.**

### Fixed
- When no page answers the exact name a caller asks for, gbrain looks for a page stored under another spelling of the same name (other capitals, or an accent stored in decomposed form). On a Rust brain that lookup was refused, so the read answered as if no such page existed, and two pages with competing spellings were not reported as ambiguous. The lookup is now a typed engine call that the Rust engine serves, so the read finds the same page on every engine.
