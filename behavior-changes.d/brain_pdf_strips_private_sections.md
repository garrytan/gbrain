---
kind: fix
---
PDFs made with the brain-pdf skill now leave out what gbrain publish leaves out: the Timeline, Facts and Takes blocks, HTML comments, citations and brain links, not just the frontmatter. The skill strips the page with the new gbrain publish --markdown, which writes the stripped markdown instead of an HTML page. A page whose frontmatter never closes is refused instead of rendered.
