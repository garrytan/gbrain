**On a Rust brain, the engine graduation drain's blocker check now answers, and more of the persistence byte-order checks run on the Rust engine.**

### Fixed
- The graduation drain's blocker check (the in-flight and recovering requests, recovering topology changes and effects, other hosts' checkout bindings and OAuth clients bound to a missing source) read through raw SQL, so a Rust primary refused it. Failback from Rust to Postgres drains through this check. The reads are now typed engine members with the same SQL text on PGLite and Postgres, and a Rust brain answers them from its own records.
- Two more persistence reads are typed engine members with their SQL text unchanged: the replay of finished recovery resolutions under one preview hash (used by `gbrain repair stuck-recovery`, whose recovery scan still stops on Rust until managed mode lands), and the read-only-mirror and unbound-source checks of a page now use the existing typed database-only read. A Rust brain answers them.
