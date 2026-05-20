---
domain: skills
action: list
version: 1
---

## input

```json
{}
```

## success

```json
{
  "count": "integer (number of available skills)",
  "skills": [
    {
      "name": "string (skill filename without .md)",
      "keywords": ["string"]
    }
  ]
}
```

## error

```json
{
  "code": "SKILLS_DIR_MISSING",
  "message": "string"
}
```

## examples

### valid-standard
```json
{}
```

### invalid-extra-field
```json
{
  "unexpected": "this field should be ignored"
}
```
