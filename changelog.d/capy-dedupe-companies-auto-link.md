**A person's pages are never linked without you: a person pair that shares an id is confirmed on its own, after you read why it was proposed.**

### Changed
- A person pair that shares a LinkedIn profile, GitHub login or declared id and exactly the same name stays on the `gbrain dedupe confirm` list with a hint line naming the shared id, to be confirmed on its own, and `gbrain dedupe confirm --clean` now covers company groups only.

### Fixed
- `gbrain doctor`'s reject suggestion for a confirmed decision with no group id now names its identity, which `gbrain dedupe reject` accepts, instead of a decision id it refused.
- The remedy for a duplicate decision file that does not validate says the last valid version stays applied.
- `gbrain dedupe` no longer lists `--body` among its flags; it never took one.
