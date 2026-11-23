---
important: security
---
**A remote caller with a reveal grant now gets a secret's original only when it can see that secret's marker itself.**

### Fixed
- `reveal_secret` over MCP used to return an original to any token with a reveal grant that could read some page where the marker was once recorded. Now each recorded place counts only when the caller's own read shows the marker: `get_page` for a page's text, and `takes_list`, `get_timeline`, `recall`, `get_raw_data` or `get_links` for a row, each only when the token may call that operation. Owner-only rows, stripped takes and private-facts fences, takes held by someone the caller can't read, removed markers, edited or deleted rows and places recorded only from a git commit no longer count, and the reply lists only the places that counted. The refusal is still `secret_reveal_forbidden`.
- The brain owner and the local `gbrain secrets reveal` command are unchanged.
