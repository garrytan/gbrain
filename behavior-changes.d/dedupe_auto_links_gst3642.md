---
kind: add
---
gbrain dedupe auto lists the pairs of person pages it would link without you (today C2: an email or phone only those two pages hold, in two sources) and gbrain dedupe auto --apply links them, each as an undoable decision (gbrain dedupe undo <id>); gbrain dedupe auto --off C2 removes every such link and stops it. gbrain dedupe classes now leaves out a page's copy kept under the same slug in another source, and holds back pairs whose shared id a page with another name also carries, or whose page is a room, a team or a mailbox.
