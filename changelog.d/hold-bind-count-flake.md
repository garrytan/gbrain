**A test that counts the statements of a page write no longer fails at random, and when it fails it names the extra statement.**

### Fixed
- The test that checks a new page still costs 8 database statements leaves out the WAL checkpoint probe PGLite sends on its own when its last probe is over 50 ms old, and compares each statement by its text as well as by number. The limit of 8 is unchanged. No product behavior changes.
