---
kind: breaking
exception: security
---
gbrain publish now removes a page's Timeline wherever it starts: at the first Timeline or History heading (any heading level, with or without a --- rule above it) or timeline marker, through the end of the page. It also removes gbrain's Facts and Takes blocks and every HTML comment, and anything after a block or comment that never closes. Before, the Timeline was removed only when a --- rule and one blank line came right before its heading, so most pages published it. A page whose frontmatter opens with --- and never closes is now refused with invalid_frontmatter instead of being published; close it with a --- line and publish again. A prose section headed History is dropped too, so read the output before sharing such a page.
