# OpenClaw GBrain Plugin

This package installs the optional GBrain OpenClaw native plugin.

It provides:

- `gbrain_status`, `gbrain_search`, and `gbrain_query` agent tools
- `openclaw gbrain status`
- authenticated `/plugins/gbrain/extract`

The extraction route calls OpenClaw's gateway model runner with
`openai-codex/gpt-5.4-mini` by default, so media/text extraction can use the
logged-in OpenClaw/Codex runtime instead of asking users for a model API key.

This package complements the root `openclaw.plugin.json` bundle plugin. The root
bundle exposes GBrain's skills, MCP server, and context engine. This package adds
OpenClaw-native commands, tools, and the host-owned extraction route.

## Install

From a fresh GBrain checkout:

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain
cd ~/gbrain
bun install
bun link
```

Install the plugin from the checkout:

```bash
openclaw plugins install --dangerously-force-unsafe-install ./plugins/openclaw-gbrain
openclaw plugins enable gbrain
openclaw gateway restart
openclaw plugins inspect gbrain --runtime --json
```

This bridge intentionally shells out to the reviewed local `gbrain` and
`openclaw` CLIs. OpenClaw's install scanner therefore requires the explicit
unsafe-install override. The plugin does not accept arbitrary command strings;
the command paths are configurable and arguments are built internally.

For local development, `plugins.load.paths` may point at this package directory,
or you can link it:

```bash
openclaw plugins install --link --dangerously-force-unsafe-install ./plugins/openclaw-gbrain
```

## Configure

The defaults expect `gbrain` and `openclaw` to be on PATH. Override only when
needed:

```json
{
  "plugins": {
    "entries": {
      "gbrain": {
        "enabled": true,
        "config": {
          "gbrainBin": "/absolute/path/to/gbrain",
          "openclawBin": "/absolute/path/to/openclaw",
          "envFile": "/home/user/.gbrain/gbrain.env",
          "extractionModel": "openai-codex/gpt-5.4-mini",
          "timeoutMs": 120000,
          "maxConcurrentExtractions": 1,
          "extractionQueueLimit": 8,
          "extractionQueueTimeoutMs": 30000,
          "minExtractionIntervalMs": 0,
          "maxExtractionFileBytes": 8000000
        }
      }
    }
  }
}
```

`envFile` is loaded only into spawned `gbrain`/`openclaw` commands. Values are
not returned by tools or the extraction route, so provider keys such as
`VOYAGE_API_KEY` can live in the normal GBrain env file without being copied into
OpenClaw's global launch environment.

The plugin prepends `$HOME/.bun/bin` to spawned command PATH because macOS
LaunchAgents often start with a minimal PATH. Use the source-linked CLI from
`bun link` for PGLite installs. Do not point `gbrainBin` at a
`bun build --compile` binary for local PGLite brains; compiled Bun binaries do
not bundle PGLite's `pglite.data` runtime asset.

Extraction is intentionally conservative by default: one active extraction at a
time, up to eight queued requests, and a 30s queue wait. Increase those values
only after the local OpenClaw/Codex runtime is proven to tolerate the extra load.
The route also rejects decoded file payloads larger than 8,000,000 bytes by
default; the hard plugin cap is 20 MiB.

## Smoke

```bash
gbrain --version
gbrain health
openclaw infer model run --local --model openai-codex/gpt-5.4-mini --prompt 'Return only JSON: {"ok":true}' --json
openclaw gbrain status
```

Then call `gbrain ingest-media --extract openclaw` with
`GBRAIN_OPENCLAW_GATEWAY_URL` and an authenticated gateway token available to
the caller.

The route accepts `timeoutMs` per request, clamped to 1s-300s. It defaults to
120s.
