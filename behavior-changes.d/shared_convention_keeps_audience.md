---
kind: breaking
exception: security
---
Shared skills: a file under skills/conventions/ has one copy for every skill that holds it. A publication, import_skill_proposal or put_skill, that would give that file a wider audience or another file class in a skill that already holds it now refuses with local_conflict and writes nothing. Before, the other skill's copy was republished with the new audience. Keep the file's current audience and class, or fork it under the publishing skill's own directory and point depends_on there, then submit again with a new request_id. Content changes and narrower audiences still apply.
