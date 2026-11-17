**Mention links now go to the person or company a page's frontmatter names, not to a thin page that only carries the name as its title.**

<!-- behavior-change: mention_links_thin_pages_9675 -->

### Fixed
- A person's X handle in frontmatter (`x_handle`, `twitter`, `twitter_handle` or `x`) now links text that writes `@handle` to that person. Placeholders such as `unknown`, `0`, `true` or `false` are not handles, and a bare word that happens to equal a handle does not link through it.
- When exactly one page claims a name as a frontmatter alias or handle, a page of the same kind that is only titled with that name stops collecting its mentions, and they link to the claiming page instead. The thin page itself is not changed. If the claiming page's own entry for the name is dropped by another rule, the thin page keeps the name, as before.
- A one-word person page titled with another person's first name (`Alice` when `Alice Example` exists) no longer collects every bare mention of that first name. A one-word person title that only its own page's longer alias starts with still links.
