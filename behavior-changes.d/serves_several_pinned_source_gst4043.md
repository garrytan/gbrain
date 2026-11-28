---
kind: fix
---
gbrain setup --serves several and gbrain access serves several now label the people in the source the harness reads: --source, then GBRAIN_SOURCE, then sources.default. Before, they always used source default. If you pinned a harness to another source, run its setup again with the same flags. That labels your people in that source and moves the member keys an earlier setup minted to write there; their secrets do not change. A key that setup did not mint is listed as skipped, with the gbrain auth rescope command that moves it.
