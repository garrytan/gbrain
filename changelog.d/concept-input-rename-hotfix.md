---
important: security
---

**A summary page built from a private note now stays hidden from other people after that note is renamed and another page takes its old name.**

### Fixed
- **Concepts from renamed private notes (GST-2687).** gbrain writes short claim pages (atoms) from your notes, then groups atoms into topic pages (concepts). When a private note was renamed and a later rename gave its old name to a different, public page, the concept built from that note's atoms could be read by people other than the brain owner through `get_page`, `search`, `query` and `list_pages`. The atoms themselves were already hidden in this case; the concept is now hidden the same way, because gbrain follows the note's rename history to the private page it moved to. The brain owner, trusted local commands and a credential allowed to read private pages in that source still read it, exactly as before. Nothing is rewritten: the rule is checked when a page is read.
- **Doctor.** `gbrain doctor`'s `derived_visibility` check now counts such atoms (`looser_atoms`) and concepts (`looser_concepts`), and `gbrain repair visibility` previews them as before.
- Schema migration v311 adds the database function `gbrain_concept_inputs_private`, which holds this check so search stays fast on large brains. It changes no rows. On a brain where the migration has not run yet, remote reads keep working and still hide these concepts.
