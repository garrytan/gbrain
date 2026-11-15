---
important: security
---
- `sources_resolve_path` no longer shows that a committed file exists, or its frontmatter slug, to a member who could not read the page that file would become. Before, such a file was hidden only once it had a page. The brain owner's own connections are unchanged.
- A page the owner asked to purge, whose purge was held, now writes its purge tombstones when a later consented `gbrain pages purge-deleted` removes it, so the same content is not imported again.
- The covering commands that `gbrain access rule` prints for open twins now keep `--allow-without-owner` when the rule leaves the owner out, so they are accepted as printed.
