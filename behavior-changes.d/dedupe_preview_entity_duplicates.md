---
kind: add
---
New: gbrain dedupe --preview lists groups of person and company pages that are likely the same person or company, with the evidence (the type of each shared key, never its value) and a class: clean, likely, weak, thin or conflict. --json prints a versioned contract, and --kind and --source narrow the list. gbrain doctor gains an entity_duplicates check that counts the groups and warns when there are any. Both only read: nothing is merged, linked or changed. A schema pack can now declare identity_keys on a page type, naming the frontmatter fields that hold one id per person or company.
