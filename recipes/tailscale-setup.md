---
id: tailscale-setup
name: Tailnet HTTPS
version: 0.1.0
description: Expose GBrain MCP on a stable tailnet-only HTTPS URL using Tailscale, a reverse proxy, and a stdio-to-HTTP MCP bridge.
category: infra
requires: []
secrets:
  - name: TAILSCALE_IP
    description: This machine's stable Tailscale IPv4 address.
    where: Run `tailscale ip -4`
  - name: DOMAIN_NAME
    description: A DNS hostname that should resolve to the machine's Tailscale IP.
    where: Configure this with your DNS provider.
  - name: DNS_PROVIDER_API_TOKEN
    description: Optional DNS provider token if your reverse proxy obtains public certificates with DNS-01 ACME.
    where: Create a DNS-edit token scoped to the relevant zone.
health_checks:
  - type: command
    argv: ["tailscale", "status"]
    label: "tailscale daemon"
  - type: command
    argv: ["pgrep", "-f", "mcp-proxy.*gbrain"]
    label: "gbrain stdio-to-http bridge"
  - type: http
    url: "https://$DOMAIN_NAME/sse"
    label: "gbrain tailnet HTTPS reachability"
setup_time: 20 min
cost_estimate: "$0/mo if you already have Tailscale and DNS."
---

# Tailnet HTTPS: Stable URL for GBrain MCP

GBrain's MCP server runs over stdio. To reach it from another tailnet device
over HTTPS, put a small HTTP bridge in front of `gbrain serve`, then terminate
TLS with a reverse proxy that only accepts Tailscale traffic.

End state:

- `https://$DOMAIN_NAME/sse` resolves to this machine's Tailscale IP.
- The reverse proxy serves a valid HTTPS certificate.
- Off-tailnet traffic is rejected.
- A local bridge proxies HTTP+SSE to `gbrain serve`.

## Architecture

```text
Tailnet device
  -> DNS: $DOMAIN_NAME -> $TAILSCALE_IP
  -> HTTPS :443
Reverse proxy
  -> allow only Tailscale CGNAT range 100.64.0.0/10
  -> reverse_proxy 127.0.0.1:$GBRAIN_MCP_PORT
mcp-proxy
  -> spawns: gbrain serve
```

## Setup Flow

### Step 1: Verify Tailscale

```bash
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null)
if [ -n "$TAILSCALE_IP" ]; then
  echo "PASS: tailscale up at $TAILSCALE_IP"
else
  echo "FAIL: tailscale is not returning an IPv4 address"
fi
```

Confirm the expected hostname resolves to the same IP:

```bash
DOMAIN_NAME=your-gbrain-host.example.com
dig +short "$DOMAIN_NAME" @1.1.1.1
```

If DNS does not resolve to the Tailscale IP, create or update an A record:

- Type: `A`
- Name: your chosen GBrain hostname
- IPv4 address: output from `tailscale ip -4`
- Proxying: off, if your DNS provider offers HTTP proxying

### Step 2: Install the MCP Bridge

Use `mcp-proxy` to expose a stdio MCP server over HTTP+SSE:

```bash
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install mcp-proxy
mcp-proxy --version
```

Pick a local port:

```bash
GBRAIN_MCP_PORT=18794
if lsof -nP -iTCP:"$GBRAIN_MCP_PORT" -sTCP:LISTEN 2>/dev/null | grep -q .; then
  echo "FAIL: port $GBRAIN_MCP_PORT is already in use"
else
  echo "PASS: port $GBRAIN_MCP_PORT is free"
fi
```

Run a foreground smoke test:

```bash
mcp-proxy --sse-host 127.0.0.1 --sse-port "$GBRAIN_MCP_PORT" -- gbrain serve
```

In another terminal:

```bash
curl -fsS -I "http://127.0.0.1:$GBRAIN_MCP_PORT/sse"
```

### Step 3: Run the Bridge as a Service

On macOS, a LaunchAgent works well for a per-user bridge. Use absolute paths
because launchd does not inherit your shell PATH:

```bash
MCP_PROXY_BIN=$(command -v mcp-proxy)
GBRAIN_BIN=$(command -v gbrain)
GBRAIN_MCP_PORT=18794
PLIST="$HOME/Library/LaunchAgents/dev.gbrain.mcp-proxy.plist"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.gbrain.mcp-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>${MCP_PROXY_BIN}</string>
        <string>--sse-host</string>
        <string>127.0.0.1</string>
        <string>--sse-port</string>
        <string>${GBRAIN_MCP_PORT}</string>
        <string>--</string>
        <string>${GBRAIN_BIN}</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/gbrain-mcp-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/gbrain-mcp-proxy.err.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/dev.gbrain.mcp-proxy"
```

Validate:

```bash
pgrep -f "mcp-proxy.*gbrain" >/dev/null \
  && echo "PASS: bridge running" \
  || echo "FAIL: bridge is not running"

curl -fsS -I "http://127.0.0.1:$GBRAIN_MCP_PORT/sse"
```

On Linux, use the same `mcp-proxy ... -- gbrain serve` command under systemd
or your normal service manager.

### Step 4: Configure the Reverse Proxy

Any reverse proxy that can terminate HTTPS and restrict by remote IP works.
The important pieces are:

- Bind to the Tailscale IP or otherwise restrict access.
- Allow `100.64.0.0/10`, Tailscale's CGNAT range.
- Proxy to `127.0.0.1:$GBRAIN_MCP_PORT`.
- Use DNS-01 ACME if the hostname is only reachable on your tailnet.

Example Caddy site block:

```caddyfile
your-gbrain-host.example.com {
    @not_tailscale not remote_ip 100.64.0.0/10
    respond @not_tailscale 403

    reverse_proxy 127.0.0.1:18794
}
```

If your Caddy build supports your DNS provider's ACME module, configure the
provider in the global options or site block according to that module's docs.
For a private tailnet hostname, HTTP-01 validation usually will not work.

Validate and reload Caddy:

```bash
caddy validate --config /path/to/Caddyfile
caddy reload --config /path/to/Caddyfile
```

### Step 5: Verify End to End

From a tailnet device:

```bash
curl -fsS -I "https://$DOMAIN_NAME/sse"
```

Expected result: HTTP response headers from the bridge, or a long-lived SSE
connection if you omit `-I`.

From a non-tailnet network, the reverse proxy should reject access with 403.

## Connecting MCP Clients

Claude Code:

```bash
claude mcp add gbrain -t sse "https://$DOMAIN_NAME/sse"
```

Other clients that support remote MCP over SSE can use the same URL.

## Tricky Spots

1. **GBrain is stdio-first.** Do not point the reverse proxy directly at
   `gbrain serve`; use an MCP stdio-to-HTTP bridge.

2. **DNS provider proxying can break tailnet routing.** If your DNS provider
   offers an HTTP proxy mode, disable it so clients connect directly to the
   Tailscale IP.

3. **Private tailnet services usually need DNS-01 ACME.** Public HTTP
   challenge validation may fail because the hostname is not publicly
   reachable.

4. **Tailscale's CGNAT range is `100.64.0.0/10`.** A narrower range can reject
   valid tailnet devices.

5. **Use absolute paths in service files.** Service managers often run with a
   minimal PATH.

## Rollback

```bash
launchctl bootout "gui/$(id -u)/dev.gbrain.mcp-proxy" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/dev.gbrain.mcp-proxy.plist"
```

Remove the reverse proxy site block and DNS record if they are no longer
needed.

*Part of the [GBrain Skillpack](../docs/GBRAIN_SKILLPACK.md). See also:
[Public Tunnel](ngrok-tunnel.md), [Voice-to-Brain](twilio-voice-brain.md),
and [Remote MCP Deployment](../docs/mcp/DEPLOY.md).*
