---
kind: add
---
gbrain google setup --personal --account <email> connects an account through Google's one-click Personal mode: its own private Google app and OAuth client, stored with that account, with no weekly sign-out. gbrain google connect --import - takes a consented grant on stdin and validates it (account proof, read-only scopes) before writing. gbrain sources set-access <id> vault moves a Google source off the shared gbrain.io relay onto the account's own connection, keeping its id, private senders and ingest tiers. Once any account has its own client, credentials.json is written as version 2 and older gbrain binaries refuse to read it rather than overwrite it; upgrade every gbrain that shares the same GBRAIN_HOME.
