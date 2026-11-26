**Self-upgrade and `gbrain engine install rust` read release attestations with your GitHub token when one is set, so a busy network no longer makes them refuse a genuine release; CI also stops failing on timing-sensitive tests.**

### Changed
- Reading a release's build attestation now sends `GH_TOKEN` (or `GITHUB_TOKEN`) as a bearer token to `api.github.com` when one is set, because keyless reads share GitHub's 60-an-hour limit per IP address. Any failed attempt with the token is followed by one keyless attempt, so a token scoped to other repositories never blocks a read. With no token set the read stays keyless, as before.
- When no attestation can be read, `gbrain engine install rust` names the HTTP status with the rate-limit headers, or the network error. An attempt made with the token reports only that it failed, so the token never appears in the message.

### Fixed
- `gbrain upgrade`'s restart check no longer asks you to restart a `gbrain` process that exited, or is a zombie, after `ps` listed it (#10342).
- The release workflow's addon smoke can read attestations again (`attestations: read`), and `scripts/ubicloud/ubi-runner.sh` passes the Ubicloud key to curl through a header file instead of its command line.
- `scripts/pregate-remote-gate.sh` judges whether a branch changed the CI files from its merge base with master, so a branch behind master is no longer refused for master's own CI edits.
- Timing-sensitive tests are fixed at the cause (the OpenClaw refresh cooldown, the Postgres write-lock wait, the withdrawn-fence midnight boundary and the shard budget timeout), and the slow setup suite is split into nine files across 42 unit shards.
