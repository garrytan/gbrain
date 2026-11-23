# Notification sinks: take proposals to Slack (and anywhere else)

The dream cycle's `propose_takes` phase queues claims it found in your pages as **take proposals**, waiting for a
person to accept or reject them. Notification sinks push those proposals out: to a Slack channel with Accept / Reject
buttons, to any HTTP endpoint as a signed webhook, or to a sink type you add. When a proposal is decided anywhere (a
button, MCP `takes_proposal_accept` / `takes_proposal_reject`, or `gbrain takes propose --accept|--reject`), the sinks
hear about that too, and the Slack message is edited to show the decision.

**Say to your agent:** *"Post new take proposals to our team Slack channel so we can accept or reject them there."*

**Say to your agent:** *"Send take proposals to our webhook as well."*

## Events

| Event | When | Payload |
|---|---|---|
| `take_proposal.created` | propose_takes queued a new proposal, or `gbrain notify-backfill` queued an existing one | the proposal |
| `take_proposal.accepted` | the proposal was accepted (its take is written) | the proposal, with `acted_by`, `acted_via`, `promoted_row_num` |
| `take_proposal.rejected` | the proposal was rejected | the proposal, with `acted_by`, `acted_via`, `reason` |

The proposal snapshot: `id`, `source_id`, `page_slug`, `claim`, `kind`, `holder`, `weight`, `domain`, `status`,
`proposed_at`, `promoted_row_num`, `acted_by`, `acted_at`, `acted_via`, `reason`.

## Configuration

One JSON array of sinks, in the environment (`GBRAIN_NOTIFY_SINKS`, wins) or the brain's config:

```bash
gbrain config set notify.sinks '[{"name":"team","type":"slack","channel":"C0123456789","filter":{"min_weight":0.5}}]'
```

Every sink has:

| Key | Meaning |
|---|---|
| `name` | Unique, `[a-z0-9-]`, at most 40 characters. Recorded on each queued delivery. |
| `type` | `slack`, `webhook`, or a type you registered. |
| `enabled` | Default `true`. A disabled sink queues and delivers nothing. |
| `events` | The events it receives; default all three. |
| `filter` | Optional: `min_weight` (0..1), `kinds` (`fact`/`take`/`bet`/`hunch`), `page_prefixes` (slug prefixes such as `projects/`), `holders`, `sources`. Applies to every event of the proposal. |

Credentials never go in this config: a sink names the environment variables that hold them.

### `slack`

| Key | Meaning |
|---|---|
| `channel` | The channel id (`C…`/`G…`). Invite the app there: `/invite @<your app>`. |
| `token_env` | Variable holding the bot token. Default: the Slack connector's token (`GBRAIN_CONNECTOR_SLACK_TOKEN`, else the one saved with `gbrain connectors auth slack --token -`). |
| `interactive` | Default `true`: Accept / Reject buttons. `false` posts and edits messages without buttons. |
| `signing_secret_env` | Variable holding the app's signing secret, which verifies button clicks. Default `GBRAIN_SLACK_SIGNING_SECRET`. |
| `allowed_users` | Who may decide, as Slack user ids or emails. Unset: any member of `channel`. |
| `page_url` | Optional link for the page slug, with `{slug}` and `{source}` placeholders (an `https://` URL). |

One proposal posts one message (the outbox queues each event once per sink, and the posted channel and message ts
are recorded, so re-runs and backfills never post it twice). A decision edits that message: the buttons are replaced
by who decided, through which surface (`slack:<sink>`, `mcp:<client>`, `cli`) and when.

**Bot scopes:** `chat:write`, `users:read`, `users:read.email`, `channels:read` (and `groups:read` for a private
channel). The app's **Interactivity Request URL** is `https://<your public host>/integrations/slack/interactions`.
A minimal app manifest:

```yaml
display_information:
  name: gbrain
features:
  bot_user:
    display_name: gbrain
    always_online: false
oauth_config:
  scopes:
    bot: [chat:write, users:read, users:read.email, channels:read, groups:read]
settings:
  interactivity:
    is_enabled: true
    request_url: https://brain.example.com/integrations/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

#### How a click is decided

1. `gbrain serve --http` receives Slack's POST at `/integrations/slack/interactions`, checks the signature (HMAC-SHA256
   with the signing secret over `v0:<timestamp>:<body>`, timestamp within 5 minutes, constant-time compare: anything
   else is `401`), queues the click and answers `200` at once (Slack wants an answer within 3 seconds).
2. The dispatcher looks the clicker up (`users.info`), checks `allowed_users` or channel membership, and decides with
   the same accept / reject path the `takes_proposal_accept` / `takes_proposal_reject` operations use. The clicker's
   email is the reviewer (`acted_by`); `acted_via` (and the accepted take's write agent label) is `slack:<sink>`.
3. The decision queues `take_proposal.accepted` / `.rejected`, which edits the message. A click that is not allowed,
   or on a proposal already decided, gets a reply only the clicker sees.

The endpoint answers `404` while no interactive slack sink has a signing secret.

#### Exposing the interactions endpoint

Slack must reach the Request URL from the internet. Expose exactly `POST /integrations/slack/interactions` and nothing
else of `gbrain serve --http` (the MCP endpoint, admin UI and OAuth routes stay private): for example an ingress rule
with an exact path match on a dedicated host, with every other path answering `404`.

### `webhook`

| Key | Meaning |
|---|---|
| `url_env` | Required: variable holding the URL (`https://`, or `http://localhost` for testing). |
| `secret_env` | Optional: variable holding a signing secret. |

Each delivery is a `POST` of `{"id", "event", "subject", ...payload}` with headers `X-Gbrain-Event`,
`X-Gbrain-Delivery` (the outbox row id: stable across retries, so dedupe on it) and, with a secret,
`X-Gbrain-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. A `2xx` delivers; `408`, `429` and `5xx` retry; any
other status gives up.

## Delivery

Events go to a durable outbox (table `notification_outbox`), one row per sink, event and proposal. `gbrain serve
--http` delivers it every 10 seconds and immediately when the event is raised in the same process. A failed delivery
retries with exponential backoff (30 s doubling, capped at an hour) up to 10 attempts; a configuration error (unknown
channel, revoked token, a non-retryable webhook status) gives up at once. Queuing never fails or slows the write or
dream cycle that raises the event, and a host without a sink's credentials leaves its rows waiting rather than
burning attempts.

## Operator commands (on the brain host)

```bash
gbrain notify-status                                   # sinks, readiness, queue by status, recent failures
gbrain notify-backfill --limit 10 --min-weight 0.7     # queue already-pending proposals (highest weight first)
gbrain notify-backfill --id 42                         # queue exactly one proposal, e.g. to test a sink
gbrain notify-backfill --limit 10 --dry-run            # what would be queued
gbrain notify-drain                                    # deliver everything due now, once
gbrain notify-retry [--sink team]                      # requeue deliveries that gave up
```

Nothing posts the proposals that were pending before a sink existed; backfill them in batches you choose.

## Adding a sink type

A sink type is a factory from its config entry to an object with `ready()` (null when this host can deliver, else
why not) and `deliver(row, ctx)`:

```ts
// a module under src/, loaded before `gbrain serve --http` starts
import { registerSinkType } from './core/notifications/registry.ts';
import { NonRetryableSinkError } from './core/notifications/types.ts';

registerSinkType('teams', config => ({
  name: config.name,
  type: 'teams',
  ready: () => process.env.TEAMS_WEBHOOK ? null : 'TEAMS_WEBHOOK is not set',
  async deliver(row) {
    // row.event, row.subject (take_proposal:<id>), row.payload (the event payload)
    const res = await fetch(process.env.TEAMS_WEBHOOK!, { method: 'POST', body: JSON.stringify({ text: row.payload.proposal.claim }) });
    if (res.status >= 500) throw new Error(`teams ${res.status}`);            // retried with backoff
    if (!res.ok) throw new NonRetryableSinkError(`teams ${res.status}`);       // gives up
    return { status: 'delivered', delivery: { status: res.status } };          // recorded on the row
  },
}));
```

Register it before `gbrain serve --http` starts its dispatcher, then name `"type": "teams"` in `notify.sinks`.
`delivery` is kept on the row; a later event on the same proposal can read it (`deliveryOf`) to edit what it sent,
as the slack sink does with the message ts.
