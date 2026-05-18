---
domain: skills
action: load
version: 2
---

## input

```json
{
  "query": "string (required, non-empty — task description or keyword list)"
}
```

## success

```json
{
  "matched": "integer (number of skills matched, >= 0)",
  "content": "string (concatenated skill bodies separated by ---; empty string when matched=0)"
}
```

## error

```json
{
  "code": "EMPTY_QUERY | SKILLS_DIR_MISSING",
  "message": "string"
}
```

## examples

### valid-gbrain-query
```json
{
  "query": "search my gbrain memory for notes on agents"
}
```

### valid-coding-query
```json
{
  "query": "write a python script to parse JSON"
}
```

### valid-multi-match
```json
{
  "query": "write python code and save to gbrain brain"
}
```

### valid-planning-query
```json
{
  "query": "plan a multi-step task with todos and subtasks"
}
```

### valid-no-match
```json
{
  "query": "quantum entanglement in particle physics"
}
```

### invalid-empty-query
```json
{
  "query": ""
}
```

### invalid-missing-query
```json
{}
```
