---
kind: fix
---
Atom extraction and sync no longer write derived files into a non-default source whose folder is a Git checkout this machine does not commit (its canonical store is not Git and Git durability is off). Those writes now stay in the database (reason foreign_checkout). Files earlier runs left untracked in such a checkout are not removed; delete them by hand if you do not want them. To have the files written and committed, turn on Git durability for that source.
