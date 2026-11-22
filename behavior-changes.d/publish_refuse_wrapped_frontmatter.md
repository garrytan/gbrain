---
kind: breaking
exception: security
---
gbrain publish now refuses a page whose frontmatter sits below other text, such as the quote fence a paged gbrain get prints, with invalid_frontmatter. Before, that frontmatter was not recognized and every frontmatter line, private values included, was published. A frontmatter block counts when it starts in the first five non-blank lines with an unindented ---yaml, ---yml or ---json line, with an unindented --- line followed directly by a key: line or a { mapping, or with a pair of unindented --- lines that has a key: line between them. A page with an early horizontal rule still publishes when no Word: line follows the rule; a rule followed by a line such as Note: ... is refused, so reword that line or move the rule. Save the page with plain gbrain get or delete the lines above the frontmatter, then publish again. Republish any page you shared this way before this release.
