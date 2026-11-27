**The memory-trust evals' text scan on the Rust engine now finds the same numbers and columns as on PGLite and Postgres.**

### Fixed
- On the Rust engine the text scan now gives a long number stored as a whole jsonb value with every digit as Postgres prints it. It reads the digits the record stores, so a 17-digit number such as `100000000000000.12` is no longer printed with a different last digit, and a search for the stored number finds it.
- On the Rust engine the text scan now reads a derived generation's completeness, held context and proposal as jsonb columns, a whole number included, as the SQL engines do.
- On the Rust engine the text scan no longer reads the dates of a link transition or a link relationship, which the SQL engines keep in date columns and do not scan, so a date no longer gives an extra hit.
