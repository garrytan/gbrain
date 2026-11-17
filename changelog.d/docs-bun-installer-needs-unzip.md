**Install guides now say Bun's installer needs `unzip`, show how to get it, and give a tested route for machines where packages can't be installed.**

### Documentation
- README.md, INSTALL_FOR_AGENTS.md, docs/INSTALL.md, AGENTS.md and the company-brain tutorial say Bun's installer stops with `error: unzip is required to install bun` when `unzip` is missing, and give the check (`command -v unzip`) and the apt, dnf and apk install commands.
- INSTALL_FOR_AGENTS.md#no-unzip is a tested route for Linux machines with no `unzip` and no package manager: it puts Bun's own build in `~/.bun/bin` using only `curl` and `tar`, and checks that `gbrain` runs from a fresh login shell.
- docs/guides/troubleshooting.md has a row for the `unzip is required` error.
