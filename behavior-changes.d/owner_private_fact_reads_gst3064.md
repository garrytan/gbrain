---
kind: fix
---
get_page `as_of` on an inline page now shows a credential bound to the brain owner, making a direct remote call for itself with no room declared, the page's private fact rows, as get_page and fetch already do. Every other caller, and `known_as_of`, reads as before. An owner's remote put_page still keeps stored private rows it leaves out, so delete or edit private rows with the local CLI for now.
