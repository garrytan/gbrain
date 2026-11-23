---
kind: breaking
exception: security
---
gbrain publish now ends a page's frontmatter only at a --- line that starts at the beginning of the line, the same rule gbrain uses when it reads frontmatter. Before, an indented --- inside a multi-line frontmatter value (for example under notes: |) ended it early, and every frontmatter line after it was published. A page whose frontmatter is closed only by an indented --- is now refused with invalid_frontmatter instead of being published; close it with an unindented --- line and publish again. Republish any page whose frontmatter holds an indented --- line if you shared it before this release.
