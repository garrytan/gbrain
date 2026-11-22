**/ship's secrets check no longer stops a Rust change on seven lines that are type names, not keys.**

### Fixed
- The local pre-landing check reads a line such as `key: &RelationshipKey,` or `token: Option<&str>,` as a secret-named assignment with a random-looking value, because it treats the Rust type after the colon as the value. It failed the Rust engine's store landing on seven such lines. The base policy now names those exact lines, each in its own file, with a pattern that matches only that type annotation. Nothing else in those files, and no other Rust file, is exempt, and a real value on a line like `token: "sk-live-..."` is still flagged. This changes only what /ship checks before a push; nothing in gbrain runs differently.
