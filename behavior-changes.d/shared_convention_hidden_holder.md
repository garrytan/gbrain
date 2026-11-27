---
kind: breaking
exception: security
---
Shared skills: a file under skills/conventions/ that only skills hidden from readers hold, because their SKILL.md audience is narrower or they are private, can no longer be published to more callers through another skill, including through a public skill that a rewrite of a shared file gives it to. import_skill_proposal and put_skill now refuse with local_conflict and write nothing. Before, the other skill published the file to its own wider audience. Give the file an audience no wider than the hidden skill gives it, or fork it under the publishing skill's own directory and point depends_on there, then submit again with a new request_id. A file that another skill already shows to readers still publishes.
