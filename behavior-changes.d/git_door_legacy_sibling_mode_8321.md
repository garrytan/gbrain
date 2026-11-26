---
kind: fix
---
A strict (canonical: git) source used to refuse every write into a folder whose committed tree held a file at the legacy group-writable mode 100664, because Git refuses to write such a tree. The write now records that sibling as 100644 with the same content, which is what git commit records for it too, so the next commit in that folder shows a mode change for those files. Folders the write does not touch and the history are not rewritten.
