**`gbrain profile import` moves what another assistant remembers about you onto your own gbrain profile.**

### Added
- `gbrain profile import <file>` reads Muse's `Memory.md`, the memories JSON in a Claude data export, or the `[YYYY-MM-DD] - memory` list any assistant prints, and previews each fact with its line and facet. Nothing is saved until you run the printed `--yes --preview <hash>` command, which refuses if the file, its parse, your profile or the brain changed since the preview.
- Every imported fact is saved private and marked inferred on your own profile (a member's import lands on its own member page, never the owner's), and never replaces a fact you stated yourself. Lines that look like a password, key or token are dropped and named by line, never printed.
- Each apply keeps a receipt: `gbrain profile import --status <receipt>` shows what was saved line by line, and `--resume <receipt>` finishes an apply that stopped, sending nothing twice. The import exits 10 while writes are still finishing and 1 if anything failed.
- `--source <id>` picks the source a local import saves into; a thin client refuses `--brain` and `--source`, because the remote brain saves into the source your credential is granted.
