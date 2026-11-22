---
kind: breaking
exception: security
---
gbrain publish now refuses wrapped frontmatter whose keys start with a digit or a symbol, use a non-Latin letter, hold a space or carry a YAML anchor or tag, and an unclosed wrapped block that starts with a # comment line, with invalid_frontmatter. Before, those blocks were not recognized and their values were published. An early horizontal rule followed by any line with a colon and a space (for example Summary: ...) is now refused, so reword that line or move the rule. Publish whole pages only: a gbrain get --lines slice that starts below the opening --- holds frontmatter keys publish cannot recognize. Republish any page you shared this way before this release.
