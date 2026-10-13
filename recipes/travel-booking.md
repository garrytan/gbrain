---
id: travel-booking
name: Travel Booking
version: 0.1.0
description: Lets the agent search, price, book and service flights, hotels and rental cars through the Jinko travel MCP server. The agent sets up its own account, reads traveler preferences from the brain before searching, and files every confirmed booking as a trips/ page.
category: reflex
install_kind: copy-into-host-repo
requires: []
secrets:
  - name: JINKO_API_KEY
    description: Jinko API key (jnk_t_…). The agent mints it itself in Step 1; a user who already has a Jinko account can paste a key instead.
    where: Minted by the agent through agent registration (Step 1), or created at https://dashboard.gojinko.com/developers/keys
health_checks:
  - type: env_exists
    name: JINKO_API_KEY
    label: JINKO_API_KEY present
  - type: http
    url: "https://api.gojinko.com/health"
    label: Jinko API reachable
setup_time: 10 min
cost_estimate: "$0 to start: a new Jinko organization is on the Free plan with $5.00 of API usage per month, no card. Live searches cost more than cached ones. Trips are paid by the traveller at checkout."
---

# Travel Booking: search and book trips from the agent, filed in the brain

The brain knows that Alice is flying to Lisbon in May, who is going with her,
and that she prefers aisle seats. Without a travel provider the agent can only
repeat that. This recipe connects the agent to Jinko, a travel API built for
agents, so it can search live flights, hotels and rental cars, book them with
the user's approval, handle changes, refunds and cancellations, and file each
confirmed trip as a `trips/` page.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Run these steps on behalf of the user.

- Step 1 gets an API key. Without it, the travel server refuses every call.
- Step 2 connects the travel tools to your harness.
- Step 3 installs the skill that tells you when to use them and how to write
  trips back to the brain.
- Step 4 proves the whole path works.

**Do not skip steps. Do not reorder. Verify after each step.** Never print the
API key, the identity assertion or an access token in the conversation.

## Architecture

```
User: "book me Lisbon in May, the usual seats"
  ↓
Agent reads the brain (recall / query / get_page)
  ├── traveler preferences (home airport, airlines, seats, hotels)
  └── people/ pages of the companions
  ↓
Jinko travel MCP  https://mcp.builders.gojinko.com/mcp
  (Authorization: Bearer $JINKO_API_KEY)
  ├── search:   flight_calendar / find_dates / flight_search / hotel_search / car_search
  ├── book:     trip → checkout → user pays at checkout_url (or submit_agent_payment)
  └── service:  get_booking → flight_refund / flight_exchange / hotel_cancel / car_cancel
  ↓
Agent writes the brain (put_page / add_link / add_timeline_entry)
  └── trips/<yyyy-mm-dd>-<destination>.md, linked to each traveller's page
```

gbrain never calls Jinko. The agent calls both: the brain for context and the
record, the travel server for search and booking.

## Opinionated Defaults

- **Brain first.** Before the first search, read the traveller's preferences
  and companions from the brain, and say which defaults you applied.
- **The user approves every payment and every refund, exchange or
  cancellation.** Show the amount, get an explicit yes, then commit.
- **The user pays at `checkout_url`** unless their platform can mint a Stripe
  Shared Payment Token for agent payment.
- **One page per trip** under `trips/`, with flights, stay, travellers, total
  paid, `booking_ref` and `trip_id`. Never write passport or ID numbers, dates
  of birth, card details or the API key into a page.
- **Live price before booking.** Cached prices are indicative and for one adult;
  confirm with `flight_search` before adding a fare to a trip.

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **`curl` and `jq`** on the machine running the setup commands
3. **A harness that can connect a remote MCP server with a header** (Claude Code,
   Codex, Cursor, OpenClaw, or any client that accepts a URL and an
   `Authorization` header), or Node.js 18+ for the Jinko CLI

## Setup Flow

### Step 1: Get a Jinko API key (the agent registers itself)

Jinko supports agent registration: the agent creates its own identity and
account with no human step, then mints an API key.

**1a. Register and get an access token.** Fetch
https://auth.gojinko.com/agent/auth.md and follow its steps 1, 2 and 4 exactly,
using its commands (they keep secrets out of the output). Use these values:

- `ISSUER="https://auth.gojinko.com"`
- In step 2, register as **anonymous**: it needs no email and no human step.
- In step 4, set `RESOURCE="https://mcp.platform.gojinko.com"`. It is required:
  a token issued for any other audience, including the default one, is
  refused.

You end with `ACCESS_TOKEN`, valid for about 5 minutes. If it expires, re-run
step 4 of auth.md from the stored identity.

**1b. Mint the API key.** The Jinko platform MCP server is a standard MCP server
over Streamable HTTP. Open a session, then call `get_api_key`:

```bash
PLATFORM_MCP="https://mcp.platform.gojinko.com/mcp"
MCP_HEADERS=(-H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream')

# initialize; keep the Mcp-Session-Id header the server returns
SID="$(curl -sS -D - -o /dev/null "$PLATFORM_MCP" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gbrain-travel-booking","version":"0.1.0"}}}' \
  | awk 'tolower($1)=="mcp-session-id:" {print $2}' | tr -d '\r')"

# mint the key; the result is returned once, as server-sent events
RES="$(curl -sS "$PLATFORM_MCP" "${MCP_HEADERS[@]}" -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_api_key","arguments":{"key_name":"gbrain-agent","environment":"production"}}}')"
JINKO_API_KEY="$(printf '%s' "$RES" | sed -n 's/^data: //p' \
  | jq -r '.result.content[0].text | fromjson | .api_key')"
```

The first `get_api_key` call creates the agent's Jinko organization and a
default tenant. The key (`jnk_t_…`) is shown only once.

**1c. Store the key** where your harness reads secrets, as `JINKO_API_KEY`
(for example the harness's environment configuration or the OS keychain).
Do not echo it.

**1d. Validate** with a lookup that needs a valid key but books nothing:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "X-API-Key: $JINKO_API_KEY" \
  https://api.gojinko.com/v1/trip/key-check
```

`401` means the key is wrong or revoked. `400` (`invalid trip_id`) means the
key was accepted. The REST API takes the key as `X-API-Key`; the MCP server
takes the same key as `Authorization: Bearer`.

**If the user already has a Jinko account**, skip 1a and 1b: ask them for a key
from https://dashboard.gojinko.com/developers/keys and continue at 1c.

**STOP until the key validates.**

### Step 2: Connect the travel MCP server

Pick the block for the harness you run in:

- **Claude Code**
  ```bash
  claude mcp add --transport http jinko https://mcp.builders.gojinko.com/mcp \
    --header "Authorization: Bearer $JINKO_API_KEY"
  ```
- **Codex** (`~/.codex/config.toml`; reads the key from the environment)
  ```toml
  [mcp_servers.jinko]
  url = "https://mcp.builders.gojinko.com/mcp"
  bearer_token_env_var = "JINKO_API_KEY"
  ```
- **Cursor** (MCP settings JSON)
  ```json
  { "mcpServers": { "jinko": {
      "url": "https://mcp.builders.gojinko.com/mcp",
      "headers": { "Authorization": "Bearer <JINKO_API_KEY>" } } } }
  ```
- **OpenClaw** (`~/.openclaw/openclaw.json`)
  ```json
  { "mcpServers": { "jinko": {
      "type": "remote",
      "url": "https://mcp.builders.gojinko.com/mcp",
      "headers": { "Authorization": "Bearer <JINKO_API_KEY>" } } } }
  ```
- **Any other MCP client:** URL `https://mcp.builders.gojinko.com/mcp`, header
  `Authorization: Bearer <JINKO_API_KEY>`. The server does not read `X-API-Key`.
- **No remote MCP support:** use the CLI instead.
  ```bash
  npm install -g @gojinko/cli
  jinko auth login --key "$JINKO_API_KEY"   # or keep JINKO_API_KEY in the environment
  jinko flight-search --help
  ```

Restart the harness if it only loads MCP servers at startup, then list the
agent's tools and confirm `flight_search`, `hotel_search`, `trip` and
`checkout` are there.

### Step 3: Install the travel-booking skill

```bash
gbrain integrations install travel-booking --target <host-repo>
```

`<host-repo>` is the agent repository that holds `RESOLVER.md` or `AGENTS.md`.
This copies `skills/travel-booking/SKILL.md` into it and appends one resolver
row. The skill covers the brain lookups before a search, the booking flow, the
approval rules, and the `trips/` page format.

**Optional: typed trip pages.** The `trip` page type (`trips/`) is declared in
the `gbrain-recommended` schema pack. With the default pack, `trips/` pages are
stored and searchable as plain pages. To get typed trip pages, ask the user
first (it changes the active schema for the whole brain), then run
`gbrain schema use gbrain-recommended`.

### Step 4: Verify end to end

1. Ask the agent: "What do flights from <home airport> to Lisbon cost next
   month?" It should read the brain for the home airport, call
   `flight_calendar` or `find_dates`, and answer with indicative prices.
2. Ask: "Show me live fares for <a date from that answer>." It should call
   `flight_search`.
3. Run `gbrain integrations doctor` and confirm both `travel-booking` checks
   pass.

Do not book a real trip to test the setup: a booking charges the traveller.

### Step 5: Hand the account to the user (recommended)

An organization created by agent registration starts **unclaimed**. It stays
usable until its claim window ends (the platform MCP `whoami` tool reports
`claim.status` and `claim.expires_at`); an unclaimed organization is suspended
after that. To keep it, the user claims it:

1. Follow step 3 of https://auth.gojinko.com/agent/auth.md (the claim
   ceremony) with the user's email as the login hint.
2. Give the user the `verification_uri` it returns. They sign in on the Jinko
   dashboard and read back the code the page shows.
3. Complete the claim with that code, as auth.md describes.

After the claim, the user is an admin of the organization. The agent keeps its
key and its role; the user can change the role or remove the agent, which
revokes its keys. A person who already belongs to a Jinko organization cannot
claim a second one: use a key from their existing organization instead (Step 1,
"If the user already has a Jinko account").

## Cost Estimate

| Item | Cost |
|------|------|
| Jinko account | $0 (Free plan, no card) |
| API usage | $5.00 included per month on the Free plan; live searches cost more than cached ones. Prices are on https://dashboard.gojinko.com/developers/billing |
| Bookings | Paid by the traveller at checkout |

When the organization's balance is too low, calls return `402`. Tell the user
to top up at https://dashboard.gojinko.com/developers/billing/topup; do not
retry, the key stays valid.

## Troubleshooting

- **`invalid_target` at the token exchange (auth.md step 4):** `RESOURCE` is
  wrong. It must be exactly `https://mcp.platform.gojinko.com`.
- **`403` with `error code: 1010` from `/agent/identity`:** the request has no
  usable User-Agent (Python's default urllib one is refused). Send an explicit
  `User-Agent` header; curl's default works.
- **`rate_limit_exceeded` at registration:** registrations are limited to 5 per
  IP per hour. Wait `retry_after` seconds. Reuse an existing registration
  (auth.md step 1) instead of registering again.
- **`400` on `tools/call` to the platform MCP:** the `Mcp-Session-Id` header
  from `initialize` is missing. Re-run 1b from the `initialize` call.
- **`401` from the travel MCP:** the key is wrong, revoked, or was pasted with
  whitespace. Mint or create a new one.
- **`402`:** balance too low. See Cost Estimate.
- **`429`:** back off, then retry once.
- **Travel tools missing after Step 2:** the harness did not reload its MCP
  configuration. Restart it and list tools again.
