---
kind: fix
---
get_page `as_of`, get_page `known_as_of` and get_versions `known_as_of` now show a credential bound to the brain owner, making a direct remote call for itself with no room declared, the page's private fact rows, as get_page and fetch already do. Every other caller reads as before. An owner's remote put_page still keeps stored private rows it leaves out, so delete or edit private rows with the local CLI for now.
