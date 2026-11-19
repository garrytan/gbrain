---
kind: fix
---
A concept page hidden because one of its input pages was purged is rebuilt by the next concept synthesis from the inputs it still has, under the same page id, slug and incoming links, with its old versions and old text cleared (#9653). A concept a person or a sync deleted stays deleted. On a brain where concept synthesis never runs or has no model key, such a concept stays hidden; gbrain maintain --purge and gbrain pages purge-deleted --dry-run name it.
