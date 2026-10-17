# DashScope Qwen3.8-Flash chat (candidate)

This change adds the existing DashScope recipe's chat touchpoint for `dashscope:qwen3.8-flash`. It reuses the existing OpenAI-compatible implementation, `DASHSCOPE_API_KEY`, region-specific `base_urls.dashscope`, and authentication. It does not select an eval model, add a proxy, or change the embedding recipe. The model list is advisory, not an allowlist.

For strict-output callers such as eval judges, `thinking: 'off'` serializes `enable_thinking: false` at the top level of the native request. The switch is exact-model/provider scoped, overrides a conflicting configured value, retains sibling options, and preserves the caller's requested output cap. Tools, subagent loops and prompt-cache behavior are not advertised by this narrow recipe addition.

## Price qualification

The proposed canonical entry is a conservative **management estimate**, not Alibaba's USD billing price, a live exchange rate or a hard supplier cap. The official model card lists CNY 0.8/2.7 input/output per million tokens in Beijing and CNY 1.094/3.427 in its highest listed region. The proposed USD 0.22/0.69 uses a planning conversion floor of 5 CNY/USD and rounds upward. Verify region, prices and conversion assumptions before use; operators can use the existing `gbrain pricing set` override flow for their actual accounting rates. No explicit cache discount is assumed. Maintainers should review this estimate independently from the chat and thinking-off support.

## Verification and limits

The new serial regression uses the real gateway, native eval callers and pinned SDK with intercepted HTTP and synthetic keys. It checks exact caps and off-switch serialization, original single-A scoring, batch and Nightly A/B/C identities, terminal HTTP errors with a finite invocation guard, and unchanged embedding fields. Its serial registration isolates global fetch and gateway state. It does not demonstrate live provider acceptance, token accounting or scoring quality; those require a separately authorized live check.

Sources: [model and regional prices](https://help.aliyun.com/en/model-studio/qwen3-8-flash), [thinking controls](https://help.aliyun.com/en/model-studio/deep-thinking), [region and endpoint selection](https://help.aliyun.com/en/model-studio/base-url), [GBrain recipe extension](embedding-providers.md#my-provider-isnt-listed).
