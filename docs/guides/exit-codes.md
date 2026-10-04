# Exit codes

Every `gbrain` command exits with one of these statuses. An agent branches on
the exit code first, then reads the JSON document (`--json`) for the details:
`code`, `class`, `retryable` and `fix`. The protocol page is
[AGENT_OPERATOR_v1](../protocol/AGENT_OPERATOR_v1.md); error codes are listed in
[error codes](error-codes.md).

**Say to your agent:** *"The gbrain command exited 3. What does it need from me?"*

| Exit | Meaning | `--json` document | What the agent does |
|---|---|---|---|
| 0 | ok | the result | continue |
| 1 | failed | error envelope with `class` and `retryable` | follow `fix.next`; retry only when `retryable` is true |
| 2 | usage error or invalid input | error envelope (`invalid_params`, `unknown_flag`) | correct the command; `gbrain <command> --help` |
| 3 | `confirmation_required`: nothing ran | consent payload (`effects`, `user_message`, `fix`) | stop, relay `user_message` to the user, run `fix.command` only after they agree |
| 10 | the write was accepted and is still pending | write receipt | poll the receipt (`gbrain write-request -- <id>`); `--accept-pending` maps this to 0 |
| 11 | partial, resumable budget stop | result with `remaining_*` and `resume_command` | run `resume_command` (it is safe to re-run) |
| 75 | another runner holds the migration lock | error envelope | wait for the other runner, then retry |
| 124 | the command's own deadline elapsed | error envelope | inspect what is still running (the message names the status command) |
| 130 | interrupted (SIGINT) | error envelope | ask the user whether to re-run |

`class` and `retryable` live only in the JSON document; the exit code stays
coarse so shell scripts can branch on it.

Under contract v1, `gbrain mcp expose` and `gbrain google` still exit 2 when
they need the user's confirmation (documented legacy; changing it is a v2 item).

## Changed in this release

| Command | Before | Now | Why |
|---|---|---|---|
| `gbrain embed --stale` time-budget stop | 3 | 11 | 3 means "ask the user first"; a budget stop means "run the resume command" |
| `gbrain dream --drain` backlog left (window/deadline/lock stop, busy cycle lock) | 3 | 11 | a resumable stop; `--json` carries `resume_command` |
| `gbrain agent run … --follow` timeout | 3 | 124 | a timeout, not a consent stop; the job keeps running |
| `gbrain providers test` transient provider error | 3 | 1 (retryable) | retryable failure |
| `gbrain sources harden` with sources needing attention | 3 | 1 | failure for cron; the report names what to fix |
| `gbrain sources pull` rebase conflict aborted | 3 | 1 | failure |
| `gbrain sources remove default` / `gbrain sources archive default` | 3 | 2 | invalid input |
| `gbrain extract-conversation-facts` pages skipped on a busy lock | 3 | 1 (retryable) | re-run to finish the skipped pages |
| `gbrain call` invalid parameters | 1 | 2 | invalid input; stdout now carries the error envelope |
| `gbrain migrate embeddings`, `reindex-search-vector`, `reindex-code`, `dream retriage`, `sources connect`, `bootstrap harness` without authorization | 2 | 3 | a consent stop: the payload names the effects and the words to ask the user |
| `gbrain pglite-repair`, `reinit-pglite`, `enrich`, `connect --install` without authorization | 1 | 3 | a consent stop, not a failure |
| `gbrain book-mirror` paid fan-out without authorization | 0 | 3 | nothing ran; it used to report "cancelled" and exit 0 |
| `gbrain doctor --remediate` without a terminal and without `--yes` | 0 (it ran) | 3 | paid and destructive work waits for the user |
| `gbrain autopilot --interval`, `serve --port`, `dream --phase`, `init --mcp-only` missing flags, `delta --since` with a bad value | 1 | 2 | invalid input |
| `gbrain jobs submit` on PGLite without `--follow` or `--queue-only` | 0 (queued, no worker) | 1 (`no_worker`) | the job would wait for a worker that is not running |
