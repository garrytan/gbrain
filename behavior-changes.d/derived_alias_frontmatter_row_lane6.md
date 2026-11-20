---
kind: fix
---
On PGLite and Postgres, a frontmatter alias row sent to the derived-alias write (the page import's alias pass and reindex --aliases) is now stored the way every other frontmatter alias is: not case-sensitive and with no stored alias text. Before, those two engines kept the case flag and text the row carried, so the alias could match only one letter case and show different text from the same alias written through frontmatter. The Rust engine already stored it this way. Rows written before this release keep what they have until the page is imported again or reindex --aliases runs.
