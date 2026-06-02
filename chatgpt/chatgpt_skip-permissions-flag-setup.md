---
title: "Skip permissions flag setup"
type: note
created: 2025-09-16
updated: 2025-09-16
source: chatgpt-export
conversation_id: 68c8c0d0-1a1c-8324-95e3-901a7b09c031
message_count: 2
tags: [chatgpt, import, code]
---
# Skip permissions flag setup

> Conversation ID: 68c8c0d0-1a1c-8324-95e3-901a7b09c031
> Created: 2025-09-16T01:43:44Z
> Updated: 2025-09-16T01:44:13Z
> Messages: 2

---

## User

Claude dangerously skip permissions flag

---

## Assistant

Mr. White — if you want Claude/Cascade to stop asking for write perms and just execute edits, the flag you’re looking for is:

### Windsurf Cascade
Put this on the cascade or per-agent level:

**JSON**
```json
{
  "name": "repo-wide-refactor",
  "dangerouslySkipPermissions": true,
  "agents": [
    {
      "name": "codegen",
      "dangerouslySkipPermissions": true
    }
  ]
}
```

**YAML**
```yaml
name: repo-wide-refactor
dangerouslySkipPermissions: true
agents:
  - name: codegen
    dangerouslySkipPermissions: true
```

You can scope it instead of repo-wide:
```json
{
  "dangerouslySkipPermissions": true,
  "writeScope": ["packages/ui/**", "apps/web/**"]
}
```

### Windsurf task configs (if you’re using per-task files)
```json
{
  "task": "refactor-ui",
  "dangerouslySkipPermissions": true
}
```

### Notes
- This bypasses file-write confirmations. Keep a narrow `writeScope` and ensure CI/branch protections are on.
- If you don’t see it taking effect, restart the Cascade run; some versions read the flag only at start.

Want me to drop a minimal `repo-wide-refactor.cascade.json` with `writeScope` limited to `packages/ui/**`?
