# The Google token socket

GBrain can hand a local agent short-lived, read-only Google access tokens, and
make write calls to Google's Workspace MCP servers on its behalf, without the
agent ever holding a refresh token, a client secret or a write-capable token.
Both go through one Unix socket owned by the brain's user.

It is off by default. Nothing here changes how `gbrain sync` reads Google.

## Start it

```bash
gbrain google mint serve          # foreground, for a supervisor (systemd, launchd)
# or let the HTTP server open it (gbrain serve --http); stdio serve never does:
gbrain config set google.mint_socket true
gbrain google mint status         # path, allowed peers, whether writes are on
```

The socket is `$GBRAIN_HOME/.gbrain/run/google.sock`, next to `cli.sock`. It
is created `0600` in a `0700` directory, and the server refuses to start when
GBRAIN_HOME or `.gbrain` belongs to another user or others can write to them.
Every connection's peer uid is read from the kernel (SO_PEERCRED on Linux,
getpeereid on macOS); a platform where that can't be read never opens the
socket. The owner (the server's own uid) is always admitted. Other uids must be
listed:

```bash
gbrain config set google.socket_peers 0          # e.g. a gateway running as root
```

In this release the socket file stays `0600`, so only the owner and root can
open it; a non-root peer uid of its own cannot reach it yet. `call` is refused
from the owner's own uid (`peer_refused`): the owner's connection is the
approval channel, so the caller must be a different uid.

The socket is not an MCP operation: remote MCP callers can never reach it.

## The wire format

One JSON object per line, one reply per line; a connection can carry many
requests. Every request has `"v":4`. Versions 1, 2 and 3 get
`unsupported_version`.

### mint: a read-only token

```json
{"v":4,"op":"mint","account":"you@example.com","profile":"ingest","caller":"my-agent"}
```

```json
{"v":4,"ok":true,"request_id":"…","access_token":"…","expires_at":"2026-11-25T13:00:00.000Z","scopes":["openid","email","https://www.googleapis.com/auth/gmail.readonly"],"account":"you@example.com"}
```

The token is Google's normal access token (about an hour), refreshed with the
account's read-only scopes only and checked against what Google returned
before it is handed out. Cache it and mint again 5 minutes before
`expires_at`, or on a Google 401. Minted tokens are kept in the socket
process's memory and are never written to the vault, so sync's own token is
untouched. `"profile":"act"` is refused with `act_not_mintable`: write
actions go through `call`. More than 120 mints a minute from one peer uid get
`rate_limited`.

### call: one write through the broker

```json
{"v":4,"op":"call","account":"you@example.com","server":"gmail","tool":"create_draft",
 "args":{"to":"bob@example.com","subject":"Hi","body":"…"},
 "turn_id":"run-42","idempotency_key":"intent-7","caller":"my-agent"}
```

`server` is one of `gmail`, `calendar`, `drive`, `docs`, `sheets`,
`slides` or `tasks` (Chat is not served). GBrain calls
`https://<server>mcp.googleapis.com/mcp/v1` itself with a write-capable token
that lives only in its own memory.

Replies:

- `{"ok":true,"result":<Google's tool result>,"request_id","quota"}`.
- `{"ok":false,"code":"input_required","request_id","message_md","choices","tool","args_hash","expires_at"}`:
  Google's approval prompt, relayed. To approve once on an owner turn, repeat
  the same call (same `idempotency_key`) with
  `"owner_verdict":{"choice":"ALLOW_ONCE","for_request":"<request_id>"}`.
  Any other choice, including Google's "always" choices, is answered by the
  owner in `gbrain google approvals`. A held prompt expires after 10 minutes
  and is dropped when the account is reconnected or disconnected.
- `owner_confirm_required`: a safety pause. The second invite to an address
  outside the account's domain in one turn, and the eleventh trash in one
  turn, wait for the owner to confirm in `gbrain google approvals`; an
  `owner_verdict` doesn't pass them. After the owner confirms, repeat the call.
- `tool_error` with `reason` `user_denied`, `admin_policy`,
  `challenge_pending` or `tool_failed`: Google's tool reported an error
  inside its result. It is never reported as success.
- `outcome_unknown`: the request may have reached Google but no reply came
  back. The broker never resends it under the same key; read first (the
  reply's `reconcile_with` names the tool), then decide.

Every `call` reply carries
`"quota":{"product","used_today","cap","day"}` for that product's UTC day.

`turn_id` is any printable string of up to 128 characters that stays the
same for every call in one turn; per-turn caps and pauses count by it. The
caller chooses it, so a caller that changes it on every call resets the
per-turn cap and pauses; the per-day cap still holds. Treat the per-turn
limits as guard rails for a cooperating agent, not a wall.

`idempotency_key` names the intent. It is recorded before the call is sent
and replayed for 24 hours: repeating a finished intent returns
`"replayed":true` without calling Google again, and reusing a key for
different arguments is `idempotency_conflict`.

### status and tools

```json
{"v":4,"op":"status","idempotency_key":"intent-7"}
{"v":4,"op":"tools","account":"you@example.com","server":"calendar"}
```

`status` returns the intent's state (`dispatched`, `held`, `done`,
`failed` or `unknown`) with no arguments or results. `tools` returns
Google's `tools/list` for that server, filtered to the tools `call`
accepts, cached for an hour.

## Argument rules

- Calendar `create_event`, `update_event`, `delete_event` and
  `respond_to_event` are sent with `notificationLevel: NONE`; any other
  level is refused (`broker_args_refused`), so the broker never emails
  attendees.
- Gmail `create_draft` takes at most 20 recipients across to, cc and bcc.
  Gmail's MCP server has no send tool.
- Drive's MCP server has no sharing tool, so there is nothing to share.
- Anything off the allowlist (Google's published tools for those servers) is
  `tool_not_allowed`.

The broker allows at most 25 calls per turn (`turn_cap`) and 1,500 per
product per UTC day (`day_cap`). Google's own throttling (`rate_limited`
with `retry_after_s`) wins over both; a throttled call had no effect, so repeat
it with the same `idempotency_key` after `retry_after_s`. Calls made at the same
time in one turn count toward the caps and safety pauses as soon as each is
accepted, before Google answers; a call that had no effect gives its place
back. At most 64 calls wait for the owner at once; past that, a new call gets
`rate_limited` until one is answered or expires. A connection idle for 5
minutes is closed.

## Turning writes on

`call` answers `broker_precondition_unmet` until every item below holds;
`gbrain google mint status` lists what is missing.

1. `gbrain config set google.broker_act true` (default false).
2. `gbrain config set google.socket_peers <uid>`: the peers are named.
3. The agent can't read GBRAIN_HOME: no peer is the broker's own uid or root,
   and GBRAIN_HOME has no group or other access (`chmod 700`). Run the
   broker as its own non-root user so the agent's uid can't read the vault; a
   broker running as root never passes, because its approval channel could not
   be told apart from a root caller.
4. `gbrain config set google.broker_joint_probe 4`, once the caller's plugin
   has passed its compatibility check against this socket.

**A gateway that runs as root.** Root reads every file, so no uid can wall
the vault off from it. `gbrain config set google.broker_allow_root_gateway true`
admits a uid 0 peer and skips item 3; everything else still holds, and every
audit line records the opt-in. Residual risk, stated plainly: an
`owner_verdict` is asserted by the peer, so anything running as that root
gateway can approve a prompt once with `owner_verdict` ALLOW_ONCE; the
owner-only channel (any choice, safety-pause confirmations) stays with the
broker's own uid. That is no new exposure on such a box,
because the same process can already read the vault. The allowlist, argument
rules, caps, safety pauses and audit log limit what can go wrong through the
broker; they are not a wall against root.

The account also needs a write scope on its grant. A Personal-mode connection
holds read-only scopes, so `call` answers `insufficient_scope` until write
scopes are added.

## Owner approvals

```bash
gbrain google approvals                              # what is waiting, with expiry
gbrain google approvals answer <request_id> ALLOW_ONCE
```

Only the owner's own uid can list or answer held prompts over the socket, and
`answer` runs only at a terminal. The list shows each held call's arguments so
the owner can see what a safety pause would send. Turning `google.broker_act` off
stops held prompts too: an answer is refused while the broker is off.

## gwscli

```bash
gbrain google exec --account you@example.com -- gwscli gmail list
```

`exec` mints a read-only token in-process, runs `gwscli` with
`--oauth_token=<token>` and `GWSCLI_TELEMETRY_ENABLED=0`, and replaces the
token in its output with `[redacted:google_token]`. It runs nothing but
`gwscli`, and refuses debug and verbose flags and a caller-supplied
`--oauth_token`. gwscli takes its token only as an argument, and on Linux's
default `/proc` (no `hidepid`) any local user can read a process's arguments
while it runs, so prefer `call` where both work. `exec` runs `gwscli` by its
bare name from the caller's `PATH`: it keeps tokens out of transcripts, and
it is not a security boundary against a caller that controls `PATH`. Each
mint through `exec` adds a `gwscli-exec` line to the audit log.

## Audit and retention

`$GBRAIN_HOME/logs/google-mint.log` (`0600`) gets one line per mint and call:
time, caller, turn, account, tool, a hash prefix of the arguments, the
idempotency key, the outcome and the root-gateway flag. No token and no
content. Lines older than 30 days are dropped when the socket starts. The
broker's intent and quota state is `$GBRAIN_HOME/.gbrain/google-broker/state.json`.

## A sample client

```bash
echo '{"v":4,"op":"mint","account":"you@example.com","profile":"ingest","caller":"shell"}' \
  | socat - UNIX-CONNECT:$HOME/.gbrain/run/google.sock
```

```ts
import net from 'node:net';
const s = net.createConnection(`${process.env.HOME}/.gbrain/run/google.sock`);
s.once('connect', () => s.write(JSON.stringify({ v: 4, op: 'tools', account: 'you@example.com', server: 'calendar' }) + '\n'));
s.on('data', d => { console.log(JSON.parse(String(d).split('\n')[0])); s.end(); });
```

## Error codes

Every failure is `{"v":4,"ok":false,"code","message","request_id","recovery","actor","docs"}`.
`request_id` matches the audit line. `recovery` is `wait` (with
`retry_after_s`), `fix_and_retry`, `ask_human` or `reconcile_first`.

| Code | Recovery | Meaning |
|---|---|---|
| `malformed_request` | fix_and_retry | Not one JSON object with the op's fields. |
| `unsupported_version` | fix_and_retry | `v` is not 4. |
| `unknown_op` | fix_and_retry | Not mint, call, status or tools. |
| `peer_refused` | ask_human | Only the owner lists or answers held prompts. |
| `act_not_mintable` | fix_and_retry | Only `ingest` is minted. |
| `not_connected` | ask_human | No connection (or no client) for the account. |
| `revoked` | ask_human | The grant was revoked or expired; reconnect. |
| `insufficient_scope` | ask_human | The grant lacks the scopes this needs. |
| `client_not_agent` | ask_human | A hosted-relay account; connect it with its own client. |
| `client_user_mismatch` | ask_human | Google says the client belongs to another account. |
| `write_scope_refused` | ask_human | Google returned a write-capable token for a mint. |
| `rate_limited` | wait | Too many mints, too many calls waiting for the owner, or Google is throttling. |
| `broker_precondition_unmet` | ask_human | Writes are off; `unmet` lists why. |
| `tool_not_allowed` | fix_and_retry | Off the allowlist. |
| `broker_args_refused` | fix_and_retry | Outside the argument rules. |
| `input_required` | ask_human | Google's approval prompt. |
| `owner_confirm_required` | ask_human | A safety pause. |
| `verdict_expired` | fix_and_retry | The held prompt is gone; re-call with a new key. |
| `verdict_mismatch` | fix_and_retry | The verdict names another prompt, turn or caller. |
| `verdict_already_answered` | fix_and_retry | Already answered. |
| `turn_cap` | ask_human | 25 calls on this turn. |
| `day_cap` | wait | 1,500 calls for this product today. |
| `outcome_unknown` | reconcile_first | It may have happened; read first. |
| `tool_error` | ask_human | Google's tool failed; see `reason`. |
| `idempotency_conflict` | fix_and_retry | The key names a different call. |
| `intent_unknown` | fix_and_retry | No intent with this key in 24 hours. |
| `upstream` | wait | Google refused or failed the request. |
| `internal` | ask_human | A bug; run `gbrain doctor --json`. |

On the client side, `mint_socket_down` means nothing serves the socket:
start it with `gbrain google mint serve`, or set `google.mint_socket` and
restart `gbrain serve --http`.
