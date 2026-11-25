**A forgotten fact whose text holds an unusual space character (such as U+0085) now stays struck in Markdown export on every engine.**

### Fixed
- Postgres folded whitespace in fact text by the database locale, so on `en_US.utf8` a claim holding U+0085 kept that character in the export text and in its fingerprint, while PGLite and the Rust store folded it to a space. A withdrawal of such a claim could then miss its fence row and export it live. Every engine now folds one explicit whitespace list (migration v341). Withdrawals Postgres stored under the old fingerprint keep matching, a current-fingerprint copy is added where the claim text still exists, and no stored hash is rewritten. Run `gbrain apply-migrations --yes` (or any command that opens the brain) to apply it.
