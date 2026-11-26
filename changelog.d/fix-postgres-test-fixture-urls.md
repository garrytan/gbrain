**PostgreSQL upgrade and vector tests accept fixture URLs with connection options.**

### Fixed

- The upgrade test compares the complete redacted fixture URL, including expected query options, against its frozen configuration output.
- The vector statement test sets `prepare=false` while retaining options such as `sslmode=disable`.
