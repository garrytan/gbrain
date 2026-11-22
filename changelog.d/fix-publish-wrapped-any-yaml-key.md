---
important: security
---
**`gbrain publish` refuses more wrapped frontmatter: any YAML key shape, and a block that starts with a comment.**

<!-- behavior-change: publish_wrapped_any_yaml_key -->

### Fixed
- `gbrain publish` refuses frontmatter that sits below other text, but it recognized a block only when its key started with an ASCII letter or `_`. A block whose keys started with a digit or a symbol (`2fa_backup:`, `$secret:`), used a non-Latin letter, or held a space (`home address:`) was published, values included. Any plain or quoted YAML key now counts. A block that never closes and starts with a `# comment` line is now read past the comment too. A rule followed by a line with a colon and a space, such as `Summary: …`, is refused, so reword that line or move the rule.
- The publish skill now says to publish whole pages only: a `gbrain get --lines` slice that starts below the opening `---` has frontmatter keys publish cannot recognize.
