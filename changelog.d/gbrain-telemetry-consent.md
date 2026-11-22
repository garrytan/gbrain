**When `gbrain init` creates a brain, your agent now asks you whether gbrain may send usage data, and nothing is sent until you answer yes.**

### Added
- `gbrain init` and `gbrain setup <harness>` add a usage-data question to the settings your agent relays after the install. No option is marked recommended, nothing is chosen by default, and the agent is told to ask you and never answer for you; `--yes`, `--json` and unattended runs never answer it. Your answer is the command the agent runs: `gbrain telemetry anonymous`, `community` or `off`.
- Before you answer, setup, init and failed-upgrade results wait only on your machine, in `~/.gbrain/telemetry/pending.jsonl` (at most 50, for 7 days), and only once a gbrain home exists. A yes moves them into the send queue; `off` deletes them. `GBRAIN_TELEMETRY=off` keeps nothing at all.
- `gbrain telemetry` and `gbrain telemetry show` list what is waiting for your answer.

### Changed
- README has a "Privacy & telemetry" section, and docs/guides/telemetry.md explains the question and the waiting file.
