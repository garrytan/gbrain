---
kind: fix
---
gbrain repair captured-facts now recognises facts captured from Codex sessions: it reads the session ids from the rollout file names in the live and archived Codex session folders, so those facts count as not suspect instead of unclassifiable. The preview's counts change on brains that capture from Codex; nothing is deleted or changed by the classification itself.
