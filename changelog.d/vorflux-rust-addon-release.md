**`gbrain engine install rust` downloads, checks and installs the Rust engine addon for this release, so the optional Rust engine and its shadow mode work on a normal install without a development setting.**

### Added
- Each release now publishes the Rust engine addon for linux-x64-glibc and darwin-arm64, with a manifest of their SHA-256 checksums. All three files carry a build attestation from the release workflow.
- `gbrain engine install rust [--from <file>] [--json]` downloads this machine's addon from the release of the running version. It checks the addon's SHA-256 against the manifest and both files' attestations, then installs it where the Rust engine and shadow mode load it. Running it again when the addon is installed makes no network call.
- `gbrain post-upgrade`, and autopilot's automatic upgrade, install the new release's addon for a brain on the Rust engine or with shadow mode on. An upgrade never fails because of it.
- `gbrain engine status --json` reports the addon (`rust_addon`) for those brains: whether it is installed, its checksum and the checksum the release pins.

### Changed
- A missing addon now says to run `gbrain engine install rust`. Four new reasons describe a refused install: `not_published`, `fetch_failed`, `verification_failed`, and `unsupported_target` (no addon for this platform).

Brains on PGLite or Postgres are not changed. They never download the addon or create its directory.
