**Operators can extract atoms from reviewed page revisions and repair missing creation dates without rewriting page bodies.**

### Added

- `gbrain dream --phase extract_atoms --source <id> --atom-pages-file <file>` processes a finite JSON list of exact page revisions. Changed and unlisted pages are skipped, and this mode does not discover transcripts.
- `gbrain repair frontmatter --fill-created --only <path>` proposes the recorded creation time for a named managed page. Apply is preview-bound and refuses when the file contains unindexed body changes.
- `gbrain facts review-relink` lets a local operator replace a model's unlinked-fact memo using a quote from its original page revision. The previous memo is retained in the local audit log.
