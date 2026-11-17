---
kind: add
---
New command gbrain filing picks how a source files its new pages: generic (by type, the default and what every brain did before), para (projects, areas, resources, archives), lyt (atomic notes in notes/, maps of content in maps/) or zettelkasten (flat in zettel/, each note named by a time id). gbrain filing set <mode> stores the choice in the source's settings; gbrain filing route <type> <title> suggests the slug and frontmatter for a new page and never suggests a slug the source already uses. Nothing moves: existing pages stay where they are, and a source with no mode set behaves exactly as before.
