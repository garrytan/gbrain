---
important: security
---
**`gbrain publish` decides whether text below a wrapper line is frontmatter with gbrain's own YAML parser, so no key shape slips through.**

<!-- behavior-change: publish_wrapped_yaml_parse -->

### Fixed
- `gbrain publish` refuses a page whose frontmatter sits below other text, but it recognized that frontmatter by matching key lines against a pattern, and keys the pattern missed were published with their values: an indented key block, a key holding a colon (`a:b:`, `time 10:30:`), a `[a, b]:` key, a block opened by a tag or anchor on its own line (`!!map`, `&a`), and empty-quoted, `-:` and `?:` keys. Publish now reads the block with the YAML parser sync uses to decide frontmatter: the text between two unindented `---` lines in the first five non-blank lines, or after an `---` line that never closes up to the first blank line, is refused with `invalid_frontmatter` when it parses as a mapping or as a list holding one. A block the parser cannot read is refused when it holds a colon followed by a space or the line end, so malformed private YAML is never shared. Language openers (`---yaml`, `---yml`, `---json`) and `{` mappings stay refused. An early horizontal rule followed by prose, a heading, a link, a time such as 10:30, or a plain list still publishes; a rule followed by `- Label: value` list items is now refused, so reword those lines or move the rule.
- `gbrain publish` no longer writes over the page it is publishing, as HTML or with `--markdown`. An `--out` that named the page itself (the same path, a symlink or hard link to it, a path through a symlinked folder, or a case variant on a case-insensitive filesystem), or a default output name that happened to be the page, replaced the page with the published copy. Publish now refuses with `invalid_params` and writes nothing; pass a different `--out` path.
