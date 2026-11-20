---
kind: breaking
exception: data-loss
---
A gbrain put that names no source no longer writes a second copy of a page that lives in another source. Before, once the default source held one page, gbrain put people/alice-example --force for a page that lived only in your git source wrote a new copy into default. An unscoped get then showed that copy, while the page in the git source and its file kept the old text. Now that put is refused. The error names the source that holds the page and the command to run instead, for example gbrain put people/alice-example --source-id vault --force. Scripts that relied on the old behavior must now pass --source-id. A put that names its source (--source-id, --source, GBRAIN_SOURCE or a .gbrain-source file) works as before. When an unsourced put goes to default while your only other git source is federated, gbrain now prints the routing notice it already printed for other commands.
