---
kind: add
---
gbrain dedupe auto now also collapses two person pages in one source with the same name and a shared id, email or phone (class C7). The newer page gets merged_into pointing at the older one, which takes its title as an alias. Nothing is deleted, and with a repository each collapse is one commit. gbrain dedupe undo <collapse id> or reject <collapse id> takes one back, and gbrain dedupe auto --off C7 takes back them all. Like C2 links, nothing changes until you run gbrain dedupe auto --apply. Automatic C2 links also hold back a few more pairs. A phone extension is its own number, distinct_from holds across sources, a rejected pair stays apart after a rename, and a title with a digit or a lone first name no longer reads as a handle.
