# ChatGPT OAuth chat provider

`codex-oauth` lets GBrain use GPT-5.6 Luna, Terra, and Sol through a ChatGPT
subscription. It uses the official Codex app-server and its managed OAuth
store; it does not accept or inherit OpenAI API keys. OAuth covers reasoning
calls only: GBrain still needs a separate embedding and expansion provider.

## Login and runtime

Install exactly Codex CLI 0.147.0, then create a private OAuth home owned by
the GBrain service user and run the login as that user:

```bash
install -d -m 0700 -o <gbrain-user> -g <gbrain-group> /var/lib/gbrain/codex-oauth
sudo -u <gbrain-user> env \
  HOME=/var/lib/gbrain/codex-oauth \
  CODEX_HOME=/var/lib/gbrain/codex-oauth \
  /absolute/path/to/codex login --device-auth
```

Do not copy another user's `auth.json`. Keep the generated file owner-only and
leave this OAuth home's `config.toml` empty; the provider supplies and verifies
the locked no-tools config itself.

Set the service environment:

```bash
GBRAIN_CODEX_HOME=/var/lib/gbrain/codex-oauth
GBRAIN_CODEX_CLI_BIN=/absolute/path/to/codex
GBRAIN_CHAT_MODEL=codex-oauth:gpt-5.6-luna
NVIDIA_API_KEY=<nvidia-key>
GBRAIN_EXPANSION_MODEL=nvidia:nvidia/nemotron-3-super-120b-a12b
GBRAIN_EMBEDDING_MODEL=nvidia:nvidia/llama-nemotron-embed-1b-v2
```

For subagent work, also enable GBrain's provider-neutral tool loop:

```bash
gbrain config set models.subagent codex-oauth:gpt-5.6-luna
gbrain config set agent.use_gateway_loop true
```

Luna is the default. Select the larger models explicitly with
`codex-oauth:gpt-5.6-terra` or `codex-oauth:gpt-5.6-sol`; all three run with
`max` reasoning. The NVIDIA key above is only for expansion and embeddings;
Luna, Terra, and Sol continue to use the ChatGPT subscription rather than
OpenAI API tokens.

## Security and limits

Every call verifies ChatGPT account mode, max reasoning, the dedicated OAuth
home, and the effective locked Codex config. GBrain injects a static
Luna/Terra/Sol catalog that marks the models as direct, with shell and native
tools disabled; Codex shell, files, web, MCP, apps, plugins, skills, memory,
goals, and subagents remain disabled. GBrain is the only tool dispatcher, and
unexpected runtime requests fail the call. Because the catalog is local, only
a successful production model call proves that the signed-in subscription is
currently entitled to the selected model.

Codex app-server 0.147 has no per-turn output-token or sampling controls, so
those settings produce warnings. Streaming, files, images, embeddings,
reranking, and transcription are unsupported. Subscription calls have zero
incremental API-key cost in GBrain's budget ledger, but ChatGPT rate and usage
limits still apply.
