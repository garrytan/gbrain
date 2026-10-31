---
name: alpha
description: Synthetic fixture skill.
tools:
  - get_page
  - shell
triggers:
  - "fixture"
---

# alpha

Run `gbrain pages purge-deleted --dry-run --json`, then:

```bash
gbrain config get <key>
gbrain search "<query>" --limit 5 | head
```

<!-- skill-drift-ok: shows a wrong invocation on purpose -->
Not `gbrain pages purgedeleted`.

Then run `gbrain jobs submit sync`.
