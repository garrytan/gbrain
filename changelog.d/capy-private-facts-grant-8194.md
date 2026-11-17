**A token or OAuth client can now be allowed to read private facts in the sources its grant names, without changing any fact (`gbrain auth rescope --private-facts granted-sources`).**

<!-- behavior-change: private_facts_grant_8194 -->

### Added
- `gbrain auth rescope --token <name> --private-facts granted-sources` (or `--client <id>`) lets that one credential's remote reads see facts saved with visibility private, only in the sources its grant names explicitly; `--private-facts none` turns it off on the next request. Every existing and new token and client starts at `none` (Discussion #8194).
- It never opens a fact held on, provenanced from or about a private, `readable_by`, folder-ruled, quarantined or member page; `context_pack`, `delta`, writes and audience or attested reads stay world-only. Only the local CLI on the brain host can set it.
- `gbrain auth list` (and `--json`), `gbrain auth clients` and the rescope before/after output show the new axis.
