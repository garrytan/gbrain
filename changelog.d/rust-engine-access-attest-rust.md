**On the Rust engine, `gbrain auth rescope --attest-sources` lists scope sources for a credential, as on PGLite and Postgres.**

### Fixed
- On a brain with the Rust engine, `gbrain auth rescope <credential> --attest-sources <list>` checks the list and marks each new scope source, and re-marks a listed source that lost its mark, with the same refusals as PGLite (the credential still reads a dropped source, holds the private-pages or private-facts grant, or the source is default, federated, archived, missing, the credential's own write source, or already readable by another credential), and `--dry-run` checks without writing. Before, it stopped with an engine error and wrote nothing.
