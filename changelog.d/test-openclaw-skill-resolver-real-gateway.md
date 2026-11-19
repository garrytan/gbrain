**Nightly CI now runs gbrain's skill-resolver plugin inside a real OpenClaw gateway, and a new bench measures how well it picks skills.**

### Added
- A test that starts a real OpenClaw gateway with a fake model and a fake Telegram Bot API, installs the plugin with `gbrain setup openclaw`, and checks what reaches the model. It covers one relevant-skills block per turn, the 750-skill case, direct messages, group messages with a mention, `--owner-sender` (other senders get only the pinned skills), cron turns (skipped) and model-error retries. It needs no API key and runs nightly on OpenClaw 2026.11.5, 2026.11.4 and 2026.10.33.
- `scripts/bench/openclaw-skill-resolver-real.ts`, which sends 320 labelled requests through a real gateway with 750 skills installed and reports how often the right skill is in the block, how often a block appears when no skill fits, and the plugin's time per turn, with and without CPU load. It runs nightly and on demand.
