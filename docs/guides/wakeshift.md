# Report back to the conversation (Wakeshift)

gbrain can wake an agent's conversation when a background job it started finishes, when a pending write settles, or when a scheduled cron reports its run, so the agent doesn't have to poll. It does this through [Wakeshift](https://wakeshift.ai), a hosted service that delivers wake-ups to Claude Code, Codex, Cursor, OpenClaw and other agent programs. It's off by default, and only the brain owner can turn it on, on the brain host.

When it's on, an agent that submits a long job calls `watch_job` with the job id and ends its turn. When the job reaches completed, failed, dead or cancelled, Wakeshift wakes that conversation with one line, for example `gbrain: job 812 (sync) finished ok in 4m12s. Call get_job 812 for the result.`. The agent then reads the result with `get_job`, through gbrain's normal access checks.

The same works for a write that answered `write_pending` (exit 10): `watch_write_request` with its `request_id` wakes the conversation when the write commits, fails, conflicts or is cancelled, and the agent reads the receipt with `get_write_request`. And for your own crons: `watch_cron` wakes the conversation the next time a cron you registered reports its run.

Without Wakeshift, `wait_job` (MCP) and `gbrain jobs wait <id>` (CLI) wait for a job, and `get_write_request` reads a write's receipt, with nothing leaving the machine. Harnesses that tell the agent when a background command exits (Claude Code, Codex, Cursor) can run `gbrain jobs wait <id>` in the background instead.

## Turn it on

1. Create an app and a key in your own Wakeshift console (`npx -y @wakeshift/cli init` or the web console). gbrain never signs anyone up or creates keys.
2. Give gbrain the key, either way:
   - `gbrain wakeshift enable --key-stdin < key.txt` saves it to `~/.gbrain/wakeshift.key` (mode 0600); or
   - put `WAKESHIFT_API_KEY=wst_…` in `~/.gbrain/.env`.

   When both are present, `WAKESHIFT_API_KEY` wins (a shell export over a `~/.gbrain/.env` value), and `--key-stdin` refuses while it is set, so it never saves a key gbrain would not use.
3. Run `gbrain wakeshift enable`. It shows what leaves the machine and asks for consent (`--yes` answers for a non-interactive run), checks the key with Wakeshift, and publishes gbrain's events. On a brain with access members it also needs your terms and privacy links (see [shared brains](#shared-brains)).

The watch tools (`watch_job`, `watch_write_request`, `watch_cron`, `list_watches`, `unwatch`, and on shared brains `accept_wakeshift_terms`) appear on the next `tools/list`. `gbrain wakeshift status` shows the state, and `gbrain wakeshift test` checks the key and app without sending a wake. `gbrain wakeshift disable` hides the tools at once and ends every open watch.

After an upgrade that adds events, run `gbrain wakeshift enable` again to publish them: `enable` stores a hash of the event manifest it published, and `gbrain wakeshift status` and `gbrain doctor` say when it is older than the installed gbrain.

## The events

| Event | Watch with | Wakes when | Payload |
| --- | --- | --- | --- |
| `gbrain.job.finished` | `watch_job` (admin scope; agent tokens only their own jobs) | the job is completed, failed, dead or cancelled | job id, kind, status, times, duration, `next: get_job <id>` |
| `gbrain.write.settled` | `watch_write_request` (write scope; only your own receipts) | the write is committed (with no recovery still running), failed, conflict or cancelled | request id, state, operation, source id, accepted and settled times, `next: get_write_request <id>` |
| `gbrain.cron.finished` | `watch_cron` (admin scope; registered names only) | the cron's next run reports ok or failed | cron name, status, finish time, a next line |

Each watch wakes once and lasts 7 days; call the watch tool again for the next job, write or run. `watch_write_request` reads the request through the same check as `get_write_request`, so a request id that isn't yours answers exactly like a missing one and nothing is sent. It works on repo-less brains and on git-backed sources alike. `unwatch` takes `job`, `request_id`, `cron` or a `watch` id from `list_watches`.

## Crons

gbrain doesn't run your crons, so the cron's own script reports its run. Register the name once, then end the script with `gbrain wakeshift emit`:

```bash
gbrain wakeshift cron add nightly-digest     # once; names are folded to a-z 0-9 . _ -
```

```bash
#!/usr/bin/env bash
# the cron's job script, run through your gbrain wrapper (docs/guides/cron-schedule.md)
status=ok
/path/to/your-job || status=failed
gbrain-run wakeshift emit cron.finished --name nightly-digest --status "$status"
```

`emit` only records the run (name, status, time) in the brain; the drainer wakes the watchers on its next tick. It never calls Wakeshift itself, never waits, and exits 0 when reporting back is off (with one line on stderr) or when the name isn't registered (it records the run and says so; `gbrain doctor` lists unregistered names it saw). It also exits 0 when it can't open the brain, and then the run is not recorded: on a PGLite brain that happens whenever `gbrain serve` or a job worker holds the brain, so on PGLite a watch on a cron only wakes for runs that finish while neither is running. A Postgres brain has no such lock. `gbrain wakeshift cron list` shows the names with their last run, and `cron remove <name>` removes one and ends its open watches. Runs older than 30 days are dropped. No report path or slug goes into the wake: the agent reads the output where the cron writes it.

## The key

A Wakeshift key is an Ed25519 private key: `wst_` followed by 50 base58 characters, the last four bytes a checksum, so a mistyped key is caught before anything is sent. Older `test_…`/`live_…` keys are refused; make a new one in the console.

- gbrain moves `WAKESHIFT_API_KEY` out of its own environment as soon as it loads its config (including a value in `~/.gbrain/.env`), so child processes and jobs don't inherit it. `gbrain wakeshift enable --key-stdin` saves a key only after the checks and your consent pass. Otherwise it reads `~/.gbrain/wakeshift.key`, which must be readable by its owner only (a looser file is ignored, and `gbrain doctor` says so).
- The key never leaves the brain host. Each request carries a fresh signed assertion that expires in two minutes.
- The key is never stored in the database or printed. `status`, `test` and `doctor` show only its kid, a 22-character fingerprint.

## Who it is for

A watch belongs to the credential that made it: the OAuth client or token, or the local stdio pipe. `list_watches` and `unwatch` touch only the caller's own watches. `watch_job` runs the same owner check as `get_job`, so an agent-scoped token can watch only the jobs it submitted. A job it doesn't own reads exactly like a missing one, and nothing is sent. If the credential is revoked or its client is deleted before the job finishes, the watch ends without a wake.

## Shared brains

On a brain with live access members (`gbrain access member list`), you, the brain owner, are the operator of a Wakeshift app that other people use, and Wakeshift's terms put duties on you:

- **Your terms.** Publish terms and a privacy policy, and pass their links to `gbrain wakeshift enable --terms-url <https url> --privacy-url <https url>`. Without them `enable` refuses (`wakeshift_shared_brain`) and names the flags. Wakeshift's Terms of Service 6.6 require your terms or privacy policy to refer members to Wakeshift's [Connector Terms](https://wakeshift.ai/connector-terms) and [Privacy Policy](https://wakeshift.ai/privacy), incorporate them (or require members to agree to them), and name Clawvisor Inc. as a third-party beneficiary of the Connector Terms. Your privacy policy must say that wakes pass through Wakeshift, operated by Clawvisor Inc. as your service provider, and what is sent, why, to whom and for how long (the table below).
- **Controller and processor.** Under Wakeshift's [Data Processing Addendum](https://wakeshift.ai/dpa) you are the controller of your members' wake data and Wakeshift is your processor. You answer members' requests to access or delete their data; removing a member makes gbrain ask Wakeshift to forget them (below).
- **Minimum age.** Wakeshift's terms make you set a minimum age for your members under the laws that apply to them, including laws on children's data. Say it in your terms.

Each person then sees one agreement step before their first watch: the first `watch_*` call returns `agreement_required` with what watching does, your two links, the Wakeshift disclosure and the Connector Terms and Privacy Policy links, and an instruction to ask the user. After the user agrees, the agent calls `accept_wakeshift_terms` with the step's `terms_version` (from a thin client's shell, `gbrain wakeshift accept-terms <terms_version>`), and gbrain records the acceptance (the person's member id or credential, the version and the time). The version is a hash of your two links, so changing either asks everyone again. A brain with no live members skips the step.

The drainer re-checks this before every wake: on a shared brain a watch whose person hasn't accepted the current terms ends with `last_error: terms_not_accepted` instead of waking. A member added after enable, on a brain whose links were never set, makes every watch refuse with `wakeshift_shared_brain` and `gbrain doctor` warn until you run `enable` with the links.

## Removing someone

`gbrain access member remove`, `gbrain auth revoke` (by name or `--id`; also a token revoked from the admin API or replaced by a harness token rotation) and `gbrain auth revoke-client` end that person's or credential's open watches (`last_error: principal_revoked`), drop its terms acceptance, and queue a Wakeshift Forget User call for the hashed user it watched under, which deletes everything Wakeshift holds for it. The command never waits on the network and works with reporting back off: `gbrain serve` or the job worker sends queued forgets on their next tick (at most 10 a tick, 5 attempts on the delivery schedule), so while reporting back is off they wait. A credential bound to a member watched under the member's user, which outlives that one credential: its watches end, and the member's user is forgotten when the member is removed. A credential deleted some other way is caught when its watch would wake: the watch ends and its forget is queued. `gbrain doctor` warns about a forget waiting more than a day. A member added again later is a new member id with its own acceptance.

## What leaves the machine

| When | To | What |
| --- | --- | --- |
| `gbrain wakeshift enable` | your Wakeshift app | the three events' names, descriptions and JSON Schemas |
| a watch call (`watch_job`, `watch_write_request`, `watch_cron`) | your Wakeshift app | a hashed user id (HMAC under a local secret, never an email or name), the MCP client name, the User-Agent, the tool call's `_meta`, the `harness`, `conversation_id` and `session_key` the agent passed, the event name, the job id, request id or cron name, and a reason line ("Watching gbrain job 812") |
| the job finishes | your Wakeshift app | the line above and a payload of the job id, its kind (handler name), status, start and finish times, duration and the next call |
| the write settles | your Wakeshift app | a line and a payload of the request id, state, operation name (for example `put_page`), source id, accepted and settled times and the next call |
| the cron reports its run | your Wakeshift app | a line and a payload of the cron name, status, finish time and a next line |
| a member is removed, a token revoked or a client deleted | your Wakeshift app | a Forget User call naming the hashed user id |

`accept_wakeshift_terms` and `gbrain wakeshift emit` send nothing; they write rows in the brain. Never sent: page text, titles or slugs, job data or results, write content or outcomes, cron output or report paths, emails, names, tokens, the key, brain paths or hostnames. Wakes are deleted from Wakeshift once delivered. Members of your Wakeshift organization can read sent wakes, and Wakeshift keeps them up to 7 days.

## Delivery and latency

Delivery is a pull, not a hook: nothing is added to the job queue or the write path. `gbrain serve` (stdio and HTTP) and the job worker check open watches every 5 seconds, and on PGLite `gbrain jobs work` checks once more before it exits. On Postgres, a wake arrives within about 5 seconds of the job finishing, the write settling or the cron's `emit`. A watch on a job or write that has already settled wakes at once.

On PGLite there is no background worker. A job submitted from a stdio session runs when `gbrain jobs work` drains the queue, after `gbrain serve` stops, and that run delivers its wakes before it exits. A wake it can't deliver arrives from the next `gbrain serve`.

Each watch lasts 7 days and delivers once. A failed delivery is tried at most 5 times in all, retrying after 30 s, 2 min, 8 min and 30 min (a rate limit waits its `Retry-After`). Any other refusal is final. A watch that dies is ended at Wakeshift, so the conversation is told. A wake Wakeshift matched to no open conversation (the user ended it, or it expired there) ends the watch with `last_error: unmatched` rather than counting as delivered. Jobs are never blocked or slowed by Wakeshift: Wakeshift being down only means the wake comes late or not at all.

Repo-less brains work the same way. Watches are operational database rows, not brain content.

## Troubleshooting

- **The watch tools are missing.** Run `gbrain wakeshift status`. Reporting back is off, or it's enabled but the key is missing, mistyped or in a key file other users can read.
- **`wakeshift_unavailable`.** Wakeshift was down, slow (10 s timeout) or rate limiting. Retry later, or use `wait_job`.
- **`wakeshift_refused`.** Wakeshift refused the request, and the reason carries its code. `other_client` means the `session_key` belongs to another program's conversation: call again without it. For anything else, run `gbrain wakeshift test`.
- **`agreement_required` instead of a watch.** The brain has members: show the user the step and call `accept_wakeshift_terms` after they agree. `wakeshift_shared_brain` means the owner hasn't set the terms links yet.
- **`gbrain doctor` warns about Wakeshift forgets.** A forget that failed for good (a final refusal or 5 failed attempts) left that user at Wakeshift: check the key and app with `gbrain wakeshift test`. Forgets queued while reporting back is off wait until `gbrain wakeshift enable`, then `gbrain serve` or the job worker sends them. Running `gbrain access member remove` again for an already-removed member queues its forget again.
- **`watch_cron` says not_found.** The name isn't registered: the brain owner runs `gbrain wakeshift cron add <name>`.
- **No wake arrived.** The result of `watch_job` says `wakeable: false` when Wakeshift didn't recognize the agent program: pass `harness`. `list_watches` shows each watch's state and last error. `gbrain doctor --only wakeshift` counts dead watches and any `id_reused` refusal (a gbrain bug: please report it).

## From a thin client

On a thin client (`gbrain init --mcp-only`), `gbrain wakeshift watch job <id>` (also `watch write <request_id>` and `watch cron <name>`) calls the brain host's watch tool over MCP and prints Wakeshift's instructions as the last line; `--session-key`, `--harness` and `--conversation-id` pass through per call and are never saved.

## OpenClaw

`gbrain setup openclaw --wakeshift` installs Wakeshift's OpenClaw plugin (pinned `@wakeshift/openclaw@1.4.31`) after consent and prints Wakeshift's `allowNetworkHooks` question without answering it ([OpenClaw guide](../mcp/OPENCLAW.md#have-gbrain-report-back-to-this-chat)).
