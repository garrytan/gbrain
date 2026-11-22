---
kind: breaking
exception: security
---
gbrain publish now recognizes a guest page saved from gbrain get, which starts with its [outside guest ...] warning line above the frontmatter. Before, the frontmatter after that line was not recognized and every frontmatter line, private values included, was published. Publish now drops the warning line and strips the frontmatter. If the frontmatter after the warning line never closes, publish refuses the page with invalid_frontmatter instead of publishing it; close it with an unindented --- line and publish again. Republish any guest page you shared this way before this release.
