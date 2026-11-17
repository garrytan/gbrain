---
kind: fix
---
The consolidate upkeep step now ends a fact only at the next fact in its cluster that says something else, by claim text and typed value. A value restated on a later date stays active from the date it was first stated, and every restated copy ends together when the value changes. Before, each copy ended at the next copy's date, so the date a value was first stated was no longer on any active row. Facts consolidated before this release keep the dates they have.
