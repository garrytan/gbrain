# OpenClaw raw inference

**Say to your agent:** "Use my existing OpenClaw model login for GBrain text inference, and verify one synthetic request before enabling background work."

The `openclaw` provider runs `openclaw infer model run --gateway`. It calls raw model inference, rather than starting an agent with tools or attaching to a conversation. OpenClaw selects and refreshes its own saved credential. GBrain does not copy a token or require a separate provider key.

```bash
openclaw infer model run --gateway --json --prompt "Return OK"
gbrain config set models.chat openclaw:default
```

Use `openclaw:<provider>/<model>` for an explicit OpenClaw model. `default` follows the system agent's configured model. The default OpenClaw agent/account binding must be verified separately from the GBrain configuration.

Message roles are rendered as labels in one prompt because the current raw CLI exposes a single prompt field; this does not preserve a model API’s separate system-message hierarchy. This text-only adapter does not expose tool loops, strict JSON schemas, expansion or embeddings. Configuring Codex inference does not establish embedding entitlement. A query/document embedding route needs its own supported capability and acceptance proof.

OpenClaw may select a subscription or a metered provider. The recipe declares no invented price. Invocation guards run before the subprocess; missing native token usage is settled as unknown. This CLI does not expose an output-token cap, so finite policies requiring that maximum must refuse the invocation. The existing `ChatResult` compatibility counters are not evidence of measured zero usage when `providerMetadata.openclaw.usageReported` is false.

Requests have a five-minute default subprocess timeout; a caller can set `timeoutMs` or abort the operation. Errors omit provider output and prompt text. The current OpenClaw CLI accepts prompt text as a process argument; deployments whose process-list boundary does not permit that must leave this adapter disabled pending a native stdin/file input interface.
