---
kind: breaking
exception: data-loss
---
Shared skills: a publication can no longer add a path that differs only by letter case from a path another skill already publishes, such as skills/conventions/guide.md next to skills/conventions/Guide.md, or a file inside a directory whose name folds to another skill's file. import_skill_proposal, put_skill and adoption now refuse with local_conflict and write nothing. Before, a case-sensitive brain host published both, and a clone on a case-insensitive file system (macOS, Windows) kept only one of them. Use the exact spelling the other skill publishes to share the file, or pick a name that differs by more than letter case, then submit again with a new request_id. A pack that already holds such a pair keeps publishing its other changes.
