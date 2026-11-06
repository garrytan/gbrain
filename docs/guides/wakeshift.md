# Report back to the conversation (Wakeshift)

gbrain can wake an agent's conversation when a background job it started finishes, so the agent doesn't have to poll. It does this through [Wakeshift](https://wakeshift.ai), a hosted service that delivers wake-ups to Claude Code, Codex, Cursor, OpenClaw and other agent programs. It's off by default, and only the brain owner can turn it on, on the brain host.

When it's on, an agent that submits a long job calls `watch_job` with the job id and ends its turn. When the job reaches completed, failed, dead or cancelled, Wakeshift wakes that conversation with one line, for example `gbrain: job 812 (sync) finished ok in 4m12s. Call get_job 812 for the result.`. The agent then reads the result with `get_job`, through gbrain's normal access checks.

Without Wakeshift, `wait_job` (MCP) and `gbrain jobs wait <id>` (CLI) wait for a job with nothing leaving the machine. Harnesses that tell the agent when a background command exits (Claude Code, Codex, Cursor) can run `gbrain jobs wait <id>` in the background instead.

## Turn it on

1. Create an app and a key in your own Wakeshift console (`npx -y @wakeshift/cli init` or the web console). gbrain never signs anyone up or creates keys.
2. Give gbrain the key, either way:
   - `gbrain wakeshift enable --key-stdin < key.txt` saves it to `~/.gbrain/wakeshift.key` (mode 0600); or
   - put `WAKESHIFT_API_KEY=wst_…` in `~/.gbrain/.env`.

   When both are present, `WAKESHIFT_API_KEY` wins (a shell export over a `~/.gbrain/.env` value), and `--key-stdin` refuses while it is set, so it never saves a key gbrain would not use.
3. Run `gbrain wakeshift enable`. It shows what leaves the machine and asks for consent (`--yes` answers for a non-interactive run), checks the key with Wakeshift, and publishes gbrain's event.

The watch tools (`watch_job`, `list_watches`, `unwatch`) appear on the next `tools/list`. `gbrain wakeshift status` shows the state, and `gbrain wakeshift test` checks the key and app without sending a wake. `gbrain wakeshift disable` hides the tools at once and ends every open watch.

## The key

A Wakeshift key is an Ed25519 private key: `wst_` followed by 50 base58 characters, the last four bytes a checksum, so a mistyped key is caught before anything is sent. Older `test_…`/`live_…` keys are refused; make a new one in the console.

- gbrain moves `WAKESHIFT_API_KEY` out of its own environment as soon as it loads its config (including a value in `~/.gbrain/.env`), so child processes and jobs don't inherit it. `gbrain wakeshift enable --key-stdin` saves a key only after the checks and your consent pass. Otherwise it reads `~/.gbrain/wakeshift.key`, which must be readable by its owner only (a looser file is ignored, and `gbrain doctor` says so).
- The key never leaves the brain host. Each request carries a fresh signed assertion that expires in two minutes.
- The key is never stored in the database or printed. `status`, `test` and `doctor` show only its kid, a 22-character fingerprint.

## Who it is for

This release reports back only on brains that serve their owner alone. `gbrain wakeshift enable` refuses a brain with live access members (`gbrain access member list`), because every member of the owner's Wakeshift organization can read the wakes it sends, and Wakeshift's terms make the operator pass its Connector Terms to each member. A member added after enable pauses reporting back: watch_job refuses with `wakeshift_shared_brain`, no wakes are sent, and `gbrain doctor` warns. Shared brains get a terms step in a later release.

A watch belongs to the credential that made it: the OAuth client or token, or the local stdio pipe. `list_watches` and `unwatch` touch only the caller's own watches. `watch_job` runs the same owner check as `get_job`, so an agent-scoped token can watch only the jobs it submitted. A job it doesn't own reads exactly like a missing one, and nothing is sent. If the credential is revoked or its client is deleted before the job finishes, the watch ends without a wake.

## What leaves the machine

| When | To | What |
| --- | --- | --- |
| `gbrain wakeshift enable` | your Wakeshift app | the event's name, description and JSON Schemas |
| `watch_job` | your Wakeshift app | a hashed user id (HMAC under a local secret, never an email or name), the MCP client name, the User-Agent, the tool call's `_meta`, the `harness`, `conversation_id` and `session_key` the agent passed, the event name, the job id, and a reason line ("Watching gbrain job 812") |
| the job finishes | your Wakeshift app | the line above and a payload of the job id, its kind (handler name), status, start and finish times, duration and the next call |

Never sent: page text, titles or slugs, job data or results, emails, names, tokens, the key, brain paths or hostnames. Wakes are deleted from Wakeshift once delivered. Members of your Wakeshift organization can read sent wakes, and Wakeshift keeps them up to 7 days.

## Delivery and latency

Delivery is a pull, not a hook. `gbrain serve` (stdio and HTTP) and the job worker check open watches every 5 seconds, and on PGLite `gbrain jobs work` checks once more before it exits. On Postgres, a wake arrives within about 5 seconds of the job finishing. A watch on a job that has already finished wakes at once.

On PGLite there is no background worker. A job submitted from a stdio session runs when `gbrain jobs work` drains the queue, after `gbrain serve` stops, and that run delivers its wakes before it exits. A wake it can't deliver arrives from the next `gbrain serve`.

Each watch lasts 7 days and delivers once. A failed delivery is tried at most 5 times in all, retrying after 30 s, 2 min, 8 min and 30 min (a rate limit waits its `Retry-After`). Any other refusal is final. A watch that dies is ended at Wakeshift, so the conversation is told. A wake Wakeshift matched to no open conversation (the user ended it, or it expired there) ends the watch with `last_error: unmatched` rather than counting as delivered. Jobs are never blocked or slowed by Wakeshift: Wakeshift being down only means the wake comes late or not at all.

Repo-less brains work the same way. Watches are operational database rows, not brain content.

## Troubleshooting

- **The watch tools are missing.** Run `gbrain wakeshift status`. Reporting back is off, or it's enabled but the key is missing, mistyped or in a key file other users can read.
- **`wakeshift_unavailable`.** Wakeshift was down, slow (10 s timeout) or rate limiting. Retry later, or use `wait_job`.
- **`wakeshift_refused`.** Wakeshift refused the request, and the reason carries its code. `other_client` means the `session_key` belongs to another program's conversation: call again without it. For anything else, run `gbrain wakeshift test`.
- **No wake arrived.** The result of `watch_job` says `wakeable: false` when Wakeshift didn't recognize the agent program: pass `harness`. `list_watches` shows each watch's state and last error. `gbrain doctor --only wakeshift` counts dead watches and any `id_reused` refusal (a gbrain bug: please report it).
