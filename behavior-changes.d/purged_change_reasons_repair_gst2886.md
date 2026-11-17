---
kind: add
---
New command gbrain repair purged-change-reasons. If you purged a fact before upgrading, a page's history could still show a change reason quoting it (#8635). Run gbrain repair purged-change-reasons on the brain host to see how many such reasons this brain holds; nothing runs it for you. If it finds any, the preview prints the apply command, which sets exactly those reasons to [purged] after you agree. Pages, files and Git history are not changed.
