---
important: security
---
**Atom extraction no longer writes into source folders this machine does not commit, never shows the model a withdrawn or held claim, and stops re-reading pages whose text did not change.**

### Fixed
- Derived writes (atoms, sync's frontmatter overlay) into a non-default source whose folder is a Git checkout this machine does not commit (not canonical Git, no durability) now stay in the database. Before, they left untracked files in someone else's checkout that nothing would ever commit. (GST-3743)
- The model reads a page the way a remote reader sees it: withdrawn claims and facts rows held from world readers are left out. Before, a withdrawn or held row reached the prompt and could come back as a world atom. On a source without managed atom maintenance, a withdrawal recorded after a page was extracted now offers that page again. (GST-4020, #10332, thanks @Kkkkkuro)
- A page renamed and made private no longer leaves world atoms behind under its old name: its next extraction retires them. (GST-4020)
- An edit that leaves the extraction input unchanged (a takes row, a private facts row) no longer calls the model: the earlier atoms move to the page's new content hash, so doctor's provenance drift check stays quiet. A revert to older text after a newer extraction still extracts again. (GST-4020, #10435, reported by @ikatsura, first fix by @Masashi-Ono0611)

<!-- behavior-change: derived_writes_foreign_checkout_gst3743 -->
<!-- behavior-change: atom_input_remote_view_gst4020 -->
