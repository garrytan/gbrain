# Chat fallback chain

`chat_fallback_chain` is an ordered list of `provider:model` entries. When a
chat call's own model fails (a rate or subscription limit, an outage, a
timeout, a rejected key) or refuses, `gateway.chat()` retries the same call
on each entry in order. The chain is off until you set it, and every hop
sends the request to another provider, so turning it on is a decision about
where your text may go.

**Say to your agent:** *"When my main chat model is down or out of quota, retry on a backup model instead of failing."*

**Say to your agent:** *"Show me which models gbrain falls back to and how to turn it off."*

## Prerequisites

- Each entry is `provider:model`, for example `openai:gpt-5.6-luna` or
  `anthropic:claude-sonnet-4-6`. A bare model name has no provider and is
  rejected.
- Each entry's provider has its own credential where gbrain runs: the API
  key its recipe names (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …, from the
  environment or `gbrain config set <vendor>_api_key`), or for
  `claude-cli:` models the `claude` binary on `PATH` (or
  `GBRAIN_CLAUDE_CLI_BIN`), which keeps its own login. Local servers
  (Ollama, llama-server, LM Studio) need none.
- When a cost cap you set applies (`facts.drain_budget_usd`,
  `cycle.extract_atoms.budget_usd`, `chronicle.job_budget_usd`, …), each
  entry needs a price, or gbrain refuses it under that cap. Register a
  missing one on the brain host with `gbrain pricing set <provider:model>
  --input <usd> --output <usd> --source <pricing-page-url>`.

## Turn it on

```bash
gbrain config set chat_fallback_chain "openai:gpt-5.6-luna,anthropic:claude-sonnet-4-6"
gbrain doctor --only chat_fallback_chain --json
```

The chain can live in three places; the first one that is set wins and the
others are reported as shadowed:

| Plane | How to set it | Removal |
|---|---|---|
| Environment | `GBRAIN_CHAT_FALLBACK_CHAIN="openai:gpt-5.6-luna,anthropic:claude-sonnet-4-6"` | delete the variable where gbrain is launched, then restart long-lived processes |
| `config.json` | `"chat_fallback_chain": ["openai:gpt-5.6-luna"]` in `~/.gbrain/config.json` | delete that key, then restart long-lived processes |
| Brain database | `gbrain config set chat_fallback_chain "<entries>"` (comma-separated, or a JSON list) | `gbrain config unset chat_fallback_chain` |

A long-lived process (`gbrain serve`, autopilot, a worker) reads the chain at
startup and keeps the old value until it restarts.

## Expected result

```json
{
  "name": "chat_fallback_chain",
  "status": "ok",
  "message": "chat_fallback_chain is active from the brain database (gbrain config set): openai:gpt-5.6-luna -> anthropic:claude-sonnet-4-6. Providers that receive traffic when a call's own model fails: openai, anthropic. It falls back on errors and on refusals, so content one provider refused is sent to the next (chat_fallback_on_refusal=false stops that). Removal is optional; ask the user.",
  "details": { "plane": "db", "chain": ["openai:gpt-5.6-luna", "anthropic:claude-sonnet-4-6"], "providers": ["openai", "anthropic"], "shadowed": [], "on_refusal": { "value": true, "plane": "default" } }
}
```

An active chain is information, not a problem: the status stays `ok`. Its
`fix` is the removal step for the plane that set it, rendered `ask_user`
(database) or `tell_user_to_run` (environment); an agent never removes a
chain on its own.

## What falls back

- A provider error moves to the next entry, with one `[ai.gateway]` line on
  stderr per hop. The first hop in a process also emits a
  `chat_fallback_hop` safety notice naming the model that failed and the one
  that received the request.
- A refusal (a `refusal` / `content_filter` stop reason, or a provider
  content block) also moves on by default, so content one provider refused
  goes to the next. To keep outage fallback but never forward refused
  content:

  ```bash
  gbrain config set chat_fallback_on_refusal false
  ```

  The same key works as `GBRAIN_CHAT_FALLBACK_ON_REFUSAL=false` or
  `"chat_fallback_on_refusal": false` in `config.json`, with the same
  precedence as the chain.
- A gbrain budget refusal or your own cancel stops the chain. When every
  entry fails, the call's own model's error is reported, so retry and halt
  decisions follow the configured model.
- Judges, critics, evals, the `models doctor` / `providers test` probes,
  `decide()`, `think --model` and `auto_think` pin their model and never use
  the chain.
- A fallback call is billed by the entry's provider; budget caps price each
  attempt by the model that actually ran.

An upgrade that finds a chain already set says so once in the
`behavior_changes` safety notice; `gbrain doctor --only behavior_changes`
shows it again.

## A failure example

An entry whose provider has no credential:

```json
{
  "name": "chat_fallback_chain",
  "status": "warn",
  "message": "chat_fallback_chain has 1 problem entry: anthropic:claude-sonnet-4-6 (no_credential). Anthropic needs ANTHROPIC_API_KEY, which is not present.",
  "fix": { "consent": ["credentials"], "actor": "user", "next": "report", "user_message": "The fallback model anthropic:claude-sonnet-4-6 needs ANTHROPIC_API_KEY. Set it where gbrain runs, or remove that entry from the brain database (gbrain config set)." }
}
```

Other causes the check names: a malformed entry (no provider prefix), an
unknown provider, a provider with no chat models, a stored value that is not
a list, and an unpriced model under a cost cap you set (its fix is the
`gbrain pricing set` command). Every check is by presence: doctor makes no
network call, starts no subprocess and sends no inference request.

## Verify

```bash
gbrain doctor --only chat_fallback_chain --json
```

`details.plane` names where the chain comes from, `details.shadowed` lists
the values it overrides, and `details.on_refusal` says whether refusals fall
back and which plane decided.

## Hosted brains

The chain belongs to the brain host: the host's environment, `config.json`
and database decide it, and the host's provider keys pay for it. A remote
MCP client (HTTP) sees only that a chain is configured, in the
`behavior_changes` notice and in `run_doctor`'s `chat_fallback_chain` check;
the entries and providers stay on the host. The host operator runs
`gbrain doctor --only chat_fallback_chain` there and changes the chain with
the commands above.
