---
kind: fix
---
gbrain doctor's sync_freshness no longer fails a source whose folder sits inside gbrain's own content directory (for example one added beside the default source with gbrain sources add) and no longer tells you to run gbrain sync for it, a command that refuses such a source with sync_not_applicable. It counts the source as a content directory where sync does not apply and names gbrain import <dir> --source <id> for adding files instead.
