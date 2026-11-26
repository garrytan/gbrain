---
kind: add
---
A remote MCP credential bound to the brain owner (access.owner_member) can now call questions_list and questions_status even where private pages are hidden from MCP. It lists only pins whose question page it can read under its source grant and reader rules, and leaves out answer sentences whose evidence is stale or unreadable to it. A slug-fenced, delegated or degraded owner credential, every other member and unbound tokens are still refused with question_owner_only, and pinning, refreshing and unpinning stay on the brain host.
