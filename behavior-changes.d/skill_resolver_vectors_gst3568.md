---
kind: default
---
The skill resolver now ranks Claude Code and Codex skills by meaning as well as by words when your brain has an embedding model (embedding_model in ~/.gbrain/config.json). To do that, each message in those harnesses is sent to the brain's embedding provider (Voyage, OpenAI or Google), and each skill index build sends your skills' names, descriptions and the start of their bodies once. A brain with no embedding model, or with embedding_disabled, keeps word matching only and sends nothing. A turn waits at most 1.5 seconds in Claude Code and 2 seconds elsewhere, and any failure answers with the word matcher's exact output. See docs/guides/skill-resolver.md, "Skill vectors".
