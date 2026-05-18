---
domain: inbox
action: check
version: 1
---

## input

```json
{
  "assigned_to": "string (optional, filter by assignee — default: 'local-ai')",
  "limit": "integer (optional, max tasks to return — default: 5, max: 20)"
}
```

## success

```json
{
  "found": "integer (number of pending tasks found, >= 0)",
  "tasks": "array of {slug, title, assigned_to, created_by, created, task_excerpt}"
}
```

## error

```json
{
  "code": "SEARCH_FAILED | INVALID_LIMIT",
  "message": "string"
}
```

## examples

### valid-default
```json
{}
```

### valid-with-assignee
```json
{
  "assigned_to": "local-ai"
}
```

### valid-with-limit
```json
{
  "assigned_to": "local-ai",
  "limit": 10
}
```

### invalid-limit-too-large
```json
{
  "limit": 100
}
```

### invalid-limit-zero
```json
{
  "limit": 0
}
```
