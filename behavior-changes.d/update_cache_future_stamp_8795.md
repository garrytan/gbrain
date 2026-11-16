---
kind: fix
---
The update check no longer trusts a saved answer stamped in the future. After a computer's clock moved backwards, the saved answer could stay "fresh" and block every refresh, which hid newer releases and a withdrawn-release notice. A saved answer more than 5 minutes ahead of the clock is now stale and is replaced on the next check.
