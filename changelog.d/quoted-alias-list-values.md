**Quoted alias fields keep the declared name whole.**

### Fixed

- Keep commas, semicolons, slashes and `or` inside quoted alias-list values from creating extra names or dropping the full declared name. The next keyless `gbrain extract --stale` refreshes derived aliases and mention links from earlier grammar versions; explicit frontmatter aliases remain intact.

<!-- behavior-change: quoted_alias_list_values -->
