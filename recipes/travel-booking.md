---
id: travel-booking
name: Travel Booking
version: 0.1.0
description: Lets the agent search, price and book flights, hotels and rental cars, and manage those bookings (changes, refunds, cancellations), through the Jinko travel MCP server. The agent sets up its own account, reads traveler preferences from the brain before searching, and files every paid booking as a trips/ page.
category: reflex
install_kind: copy-into-host-repo
requires: []
secrets:
  - name: JINKO_API_KEY
    description: Jinko API key (jnk_t_…). The agent mints it itself in Step 1; a user who already has a Jinko account saves a key from the dashboard to ~/.jinko/api-key instead (Step 1).
    where: Minted by the agent through agent registration (Step 1), or created at https://dashboard.gojinko.com/developers/keys
health_checks:
  - type: env_exists
    name: JINKO_API_KEY
    label: JINKO_API_KEY present
  - type: http
    url: "https://api.gojinko.com/health"
    label: Jinko API reachable
setup_time: 10 min
cost_estimate: "Bookings are paid by the traveller at checkout"
---

# Travel Booking: search and book trips from the agent, filed in the brain

The brain knows that Alice is flying to Lisbon in May, who is going with her,
and that she prefers aisle seats. Without a travel provider the agent can only
repeat that. This recipe connects the agent to Jinko, a travel API with an MCP
server, so it can search flights, hotels and rental cars, book them with the
user's approval, manage the bookings afterwards (changes, refunds,
cancellations), and file each paid trip as a `trips/` page.

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
  └── manage:   get_booking → flight_refund / flight_exchange / hotel_cancel / car_cancel
  ↓
Agent writes the brain (put_page / add_link / remove_link)
  └── trips/<yyyy-mm-dd>-<destination>-<trip_id>, linked to each traveller's page
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
- **Confirm the price before booking.** Prices from the flight discovery tools
  are indicative and for one adult; confirm with `flight_search` before adding
  a fare to a trip.

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **`curl` and `jq`** on the machine running the setup commands
3. **A harness that can connect a remote MCP server with a header** (Claude Code,
   Codex, Cursor, or any client that accepts a URL and an `Authorization`
   header), or Node.js 18+ for the Jinko CLI (OpenClaw)

## Setup Flow

### Step 1: Get a Jinko API key (the agent registers itself)

Jinko supports agent registration: the agent creates its own identity and
account with no human step, then mints an API key.

Each block below runs on its own: the blocks share nothing but files under
`~/.jinko/`, so a harness that runs every command in a fresh shell can follow
them as written.

**1a. Register.** The agent registers **anonymously**: no email and no human
step. The registration response holds the identity assertion and the claim
token, so it is kept in a private file and never printed. An existing
registration is reused.

```bash
ISSUER="https://auth.gojinko.com"
REG_FILE="$HOME/.jinko/agent-registration.json"
mkdir -p "$HOME/.jinko" && chmod 700 "$HOME/.jinko"

if [ ! -s "$REG_FILE" ]; then
  REG="$(curl -sS -A 'gbrain-travel-booking/0.1.0' "$ISSUER/agent/identity" \
    -H 'Content-Type: application/json' -d '{"type":"anonymous"}')"
  if printf '%s' "$REG" | jq -e '.identity.assertion' >/dev/null 2>&1; then
    (umask 077; printf '%s' "$REG" > "$REG_FILE"); echo "PASS: registered"
  else
    echo "FAIL: registration refused:"; printf '%s' "$REG" | jq -c '{code, error, message, retry_after}'
  fi
else
  echo "PASS: reusing $REG_FILE"
fi
```

**1b. Mint the API key.** Exchange the registration for a short-lived token for
the Jinko platform MCP server, open an MCP session (Streamable HTTP), and call
`get_api_key`. The key is written to a private file and never printed:

```bash
ISSUER="https://auth.gojinko.com"
REG_FILE="$HOME/.jinko/agent-registration.json"
KEY_FILE="$HOME/.jinko/api-key"
PLATFORM_MCP="https://mcp.platform.gojinko.com/mcp"

# exchange the identity for a token (about 5 minutes) for the platform MCP
ACCESS_TOKEN="$(curl -sS "$ISSUER/oauth2/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  --data-urlencode "assertion=$(jq -r .identity.assertion "$REG_FILE")" \
  --data-urlencode "resource=https://mcp.platform.gojinko.com" \
  | jq -r '.access_token // empty')"
if [ -z "$ACCESS_TOKEN" ]; then
  echo "FAIL: token exchange refused; if the registration expired, delete $REG_FILE and re-run 1a"
fi

MCP_HEADERS=(-H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream')

# initialize: keep the Mcp-Session-Id header and the negotiated protocol version
HDRS="$(mktemp)"
INIT="$(curl -sS -D "$HDRS" "$PLATFORM_MCP" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gbrain-travel-booking","version":"0.1.0"}}}')"
SID="$(awk 'tolower($1)=="mcp-session-id:" {print $2}' "$HDRS" | tr -d '\r')"; rm -f "$HDRS"
# responses arrive as JSON or as server-sent events ("data: {...}")
PROTO="$(printf '%s\n' "$INIT" | sed 's/^data: //' | jq -Rr 'fromjson? | select(.id == 1) | .result.protocolVersion // empty')"
if [ -z "$SID" ] || [ -z "$PROTO" ]; then
  echo "FAIL: initialize refused; the access token was refused or expired (re-run 1b)"
fi
MCP_HEADERS+=(-H "Mcp-Session-Id: $SID" -H "MCP-Protocol-Version: $PROTO")
curl -sS -o /dev/null "$PLATFORM_MCP" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# mint the key; it is returned once
RES="$(curl -sS "$PLATFORM_MCP" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_api_key","arguments":{"key_name":"gbrain-agent","environment":"production"}}}')"
TEXT="$(printf '%s\n' "$RES" | sed 's/^data: //' | jq -Rr 'fromjson? | select(.id == 2) | .result.content[0].text // .error.message')"
KEY="$(printf '%s' "$TEXT" | jq -Rrs 'try (fromjson | .api_key // empty) catch empty')"
if [ -n "$KEY" ]; then
  (umask 077; printf '%s' "$KEY" > "$KEY_FILE"); echo "PASS: key minted, saved to $KEY_FILE"
else
  echo "FAIL: no key in the result:"
  printf '%s' "$TEXT" | jq -Rrs '. as $t | try (fromjson | del(.. | .api_key?)) catch ($t | gsub("jnk_[A-Za-z0-9_]+"; "jnk_***"))'
fi
```

The `resource` value in the token exchange is required: a token issued for any
other audience is refused. The first `get_api_key` call creates the agent's
Jinko organization and a default tenant. The key (`jnk_t_…`) is shown only once. A result with
`status: "already_exists"` means a key with that `key_name` was minted before
and cannot be shown again: re-run the `tools/call` with a new `key_name`.

**1c. Store the key** as `JINKO_API_KEY` in the environment that both gbrain
and your harness run in (the `env_exists` health check reads it from there),
taking the value from `~/.jinko/api-key`. Do not echo it. Once it is set there,
delete the file.

**1d. Validate** with a lookup that needs a valid key but books nothing:

```bash
KEY="${JINKO_API_KEY:-$(cat "$HOME/.jinko/api-key" 2>/dev/null)}"
curl -s -o /dev/null -w '%{http_code}\n' -H "X-API-Key: $KEY" \
  https://api.gojinko.com/v1/trip/key-check
```

`401` means the key is wrong or revoked. `400` (`invalid trip_id`) means the
key was accepted. The REST API takes the key as `X-API-Key`; the MCP server
takes the same key as `Authorization: Bearer`.

**If the user already has a Jinko account**, skip 1a and 1b. Do not ask for
the key in the conversation: a key pasted there stays in the transcript. Ask
the user to create one at https://dashboard.gojinko.com/developers/keys and
save it themselves, in their own terminal, with:

```bash
mkdir -p "$HOME/.jinko" && chmod 700 "$HOME/.jinko"
(umask 077; printf 'Jinko API key: '; read -rs K; printf '%s' "$K" > "$HOME/.jinko/api-key"); echo
```

Then continue at 1c.

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
- **OpenClaw:** it registers stdio MCP servers only (`openclaw mcp add
  --command …`, see docs/mcp/OPENCLAW.md) and has no remote-MCP client, so use
  the CLI below.
- **Any other MCP client:** URL `https://mcp.builders.gojinko.com/mcp`, header
  `Authorization: Bearer <JINKO_API_KEY>`. The server does not read `X-API-Key`.
- **No remote MCP support:** use the CLI instead. It reads `JINKO_API_KEY` from
  the environment, so no login step is needed.
  ```bash
  npm install -g @gojinko/cli@latest
  jinko --version        # 3.3.0 or later
  jinko flight-search --help
  ```
  The CLI commands mirror the MCP tools (`jinko flight-search`,
  `jinko hotel-search`, `jinko trip`, `jinko checkout`, …) and print JSON.

Then verify the path you chose:

- **MCP:** restart the harness if it only loads MCP servers at startup, then
  list the agent's tools and confirm `flight_search`, `hotel_search`, `trip`
  and `checkout` are there.
- **CLI:** `jinko --version` is 3.3.0 or later (an older CLI cancels a hotel
  at once instead of previewing the refund; run the install line again to
  upgrade), `jinko auth status` reports a key taken from `JINKO_API_KEY`, and
  `jinko flight-search --help` prints the flags. The CLI adds no tools to the
  agent's tool list.

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
stored and searchable as plain pages. Choosing the schema pack is a setting for
the brain's operator, and it can apply beyond this brain (every brain that
reads the same gbrain config). Do not change it yourself: tell the user that
typed trip pages need `gbrain-recommended`, and leave the change to the
operator (`gbrain schema use gbrain-recommended` on the brain's host;
`gbrain schema active` shows the result).

### Step 4: Verify end to end

Run these checks in a new conversation, after restarting the harness if it
loads `AGENTS.md`, `RESOLVER.md` or skills only at startup. This conversation
has already read this recipe, so a check run here can pass without the
installed skill being picked up.

1. Ask the agent: "What do flights from <home airport> to Lisbon cost next
   month?" It should read the brain for the home airport, call
   `flight_calendar` or `find_dates`, and answer with indicative prices.
2. Ask: "Show me bookable fares for <a date from that answer>." It should call
   `flight_search`.
3. Run `gbrain integrations doctor` and confirm both `travel-booking` checks
   pass. They confirm only that `JINKO_API_KEY` is set and that the Jinko API
   is reachable; they do not send the key. Steps 4.1 and 4.2 are what prove
   the key works. If the key is later revoked or replaced, the first travel
   call returns `401`: run the Step 1d check again and replace the key.

Do not book a real trip to test the setup: a booking is a real purchase.

### Step 5: Hand the account to the user (recommended)

An organization created by agent registration starts **unclaimed**. It stays
usable until its claim window ends (the platform MCP `whoami` tool reports
`agent.claim.status` and `agent.claim.expires_at`); an unclaimed organization
is suspended after that. To keep it, the user claims it:

```bash
ISSUER="https://auth.gojinko.com"; REG_FILE="$HOME/.jinko/agent-registration.json"
CLAIM_TOKEN="$(jq -r .claim.token "$REG_FILE")"
EMAIL="<the user's email>"

# 1. start a claim attempt and give the user the link it returns
ATT="$(curl -sS "$ISSUER/agent/identity/claim" -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg t "$CLAIM_TOKEN" --arg e "$EMAIL" '{type:"service_auth", claim_token:$t, login_hint:$e}')")"
printf '%s' "$ATT" | jq -r '.attempt.verification_uri // .'

# 2. the user signs in at that link and reads back the code the page shows
USER_CODE="<the code the user read back>"
VER="$(curl -sS "$ISSUER/agent/identity/claim/complete" -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg t "$CLAIM_TOKEN" --arg c "$USER_CODE" '{claim_token:$t, user_code:$c}')")"
if printf '%s' "$VER" | jq -e '.identity.assertion' >/dev/null 2>&1; then
  (umask 077; printf '%s' "$VER" > "$REG_FILE"); echo "PASS: claimed"
else
  printf '%s' "$VER" | jq -c '{code, message}'
fi
```

`claim_not_confirmed` means the user has not finished on the page yet: wait
and complete again. `invalid_user_code` means the code was mistyped: ask
again. Claim links last about 5 minutes; for an expired one, start a new
attempt.

After the claim, the user is an admin of the organization. The agent keeps its
key and its role; the user can change the role or remove the agent, which
revokes its keys. A person who already belongs to a Jinko organization cannot
claim a second one: use a key from their existing organization instead (Step 1,
"If the user already has a Jinko account").

## Troubleshooting

- **`invalid_target` at the token exchange (1a):** the `resource` value is
  wrong. It must be exactly `https://mcp.platform.gojinko.com`.
- **`403` with `error code: 1010` from `/agent/identity`:** the request has no
  usable User-Agent (Python's default urllib one is refused). Send an explicit
  `User-Agent` header; curl's default works.
- **`rate_limit_exceeded` at registration:** registrations are limited to 5 per
  IP per hour. Wait `retry_after` seconds. 1a reuses the registration in
  `~/.jinko/agent-registration.json`; do not delete it to register again.
- **`400` on `tools/call` to the platform MCP:** the `Mcp-Session-Id` header
  from `initialize` is missing. Re-run 1b from the `initialize` call.
- **`claim_required` from `get_api_key`:** this Jinko environment requires the
  organization to be claimed before it issues keys. Do Step 5 first, then
  re-run 1b.
- **`401` from the travel MCP:** the key is wrong, revoked, or was saved with
  whitespace. Mint or create a new one.
- **`402`:** the account has no allowance left. Tell the user and do not
  retry; the key stays valid.
- **`429`:** back off, then retry once.
- **Travel tools missing after Step 2:** the harness did not reload its MCP
  configuration. Restart it and list tools again.
