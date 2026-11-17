**A small macOS helper that gives gbrain read-only access to your Messages history now lives in `apple/helper/`. Nothing in gbrain calls it yet.**

### Added
- `apple/helper/` is a Swift program that runs on your Mac under your own account. It answers read-only questions about your Messages history on a local port, and only for tokens you create with its `token` command. A removed token stops working on the next request. It is ported from the maintainer's private prototype, with the maintainer's consent. You build it yourself with Swift 6 (Xcode 16); a later release adds a gbrain command that builds and installs it for you.
- A macOS workflow, `Apple helper`, builds and tests the helper on every change under `apple/`. It is not a required check, and Linux and Windows installs never build or load the helper.
