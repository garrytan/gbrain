# Connect GBrain to Claude Code

## Option 1: Local (recommended, zero server needed)

```bash
claude mcp add gbrain -- gbrain serve
```

That's it. Claude Code spawns `gbrain serve` as a stdio subprocess. No server, no
tunnel, no token needed. Works with both PGLite and Supabase engines.

## Option 2: Remote (access from any machine)

If you have GBrain running on a server with a public tunnel (see
[ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)):

```bash
claude mcp add gbrain -t http \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Replace `YOUR-DOMAIN` with your ngrok domain and `YOUR_TOKEN` with a token
from `gbrain auth create "claude-code"`.

## Verify

In Claude Code, try:

```
search for [any topic in your brain]
```

You should see results from your GBrain knowledge base.

## Remove

```bash
claude mcp remove gbrain
```
