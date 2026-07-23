# Connect GBrain to Claude Code

> New to this? The [Give your coding agent a memory](../tutorials/connect-coding-agent.md)
> tutorial walks both paths (local-from-nothing and connect-to-an-existing-brain)
> end to end, plus the brain-first protocol that makes it worth it. This page is
> the connection reference.

## Option 1: Local (recommended, zero server needed)

```bash
claude mcp add gbrain -- gbrain serve
```

That's it. Claude Code spawns `gbrain serve` as a stdio subprocess. No server, no
tunnel, no token needed. Works with both PGLite and Supabase engines.

## Option 2: Remote, one command (fastest from a bearer token)

If GBrain is running somewhere as an HTTP server (`gbrain serve --http`, see the
[ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)) and you have a bearer token,
let `gbrain connect` generate the wire-up for you.

On the host (or anywhere `gbrain` is installed), mint a token and print the block:

```bash
gbrain auth create "claude-code"
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx
```

`gbrain connect` prints a short, copy-paste block. Paste it into Claude Code — it
runs the `claude mcp add` for you and tells the agent to call `get_brain_identity`
and `list_skills` so it immediately knows what the brain can do.

Already on the machine you want to wire up? Skip the copy-paste and let `connect`
do it directly, with a built-in token smoke-test:

```bash
gbrain connect https://YOUR-DOMAIN.ngrok.app --token gbrain_xxx --install
```

(`--install` runs `claude mcp add`, then verifies the token by calling
`get_brain_identity` — so a wrong or expired token fails now, not silently on the
agent's first request. The URL is normalized: a bare host without `/mcp` gets it
appended; pass an explicit `https://` scheme.)

Pipe-friendly machine output (token redacted unless `--show-token`):

```bash
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx --json
```

## Option 3: Remote, manual `claude mcp add`

Equivalent to what `gbrain connect` generates, if you'd rather run it yourself:

```bash
claude mcp add gbrain -t http \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Replace `YOUR-DOMAIN` with your ngrok domain and `YOUR_TOKEN` with a token from
`gbrain auth create "claude-code"`.

> A `gbrain auth create` token is a long-lived, full-access secret. Keep it
> private (it lands in `~/.claude.json`), and prefer a scoped/short-lived token
> where your host supports one.

## Verify

In Claude Code, try:

```
search for [any topic in your brain]
```

You should see results from your GBrain knowledge base.

> **`list_skills` returns nothing?** Skill discovery is gated by `mcp.publish_skills`
> on the host. New brains from `gbrain init` default it ON; brains upgraded from an
> older release stay OFF until you opt in. Enable it on the host with
> `gbrain config set mcp.publish_skills true`. The core tools (search, query,
> get_page, put_page, think, find_experts) work regardless. Note: `capture` is a
> CLI-only command, not an MCP tool — the agent writes over MCP with `put_page`.

## Remove

```bash
claude mcp remove gbrain
```
