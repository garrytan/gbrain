---
kind: fix
---
A Gmail message part labelled text/plain whose content is really an HTML document (it starts with a doctype, html or head tag) is now stripped to readable text, the way an HTML part is. Before, the page stored the raw tags and CSS as the message body. Pages already imported are not rewritten.
