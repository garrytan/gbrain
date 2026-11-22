---
kind: breaking
exception: security
---
gbrain publish now refuses a page whose frontmatter sits below other text, such as the quote fence a paged gbrain get prints, with invalid_frontmatter. Before, that frontmatter was not recognized and every frontmatter line, private values included, was published. A frontmatter block counts when an unindented --- line (or ---yaml, ---yml or ---json) in the first five non-blank lines opens it, the next unindented --- line closes it, and a key: line sits between them; two horizontal rules with only prose between them still publish. Save the page with plain gbrain get or delete the lines above the frontmatter, then publish again. Republish any page you shared this way before this release.
