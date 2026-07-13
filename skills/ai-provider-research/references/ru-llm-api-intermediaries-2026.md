# RU-facing LLM API intermediaries snapshot (July 2026)

This is a condensed session note for future provider research. **Refresh every price before using it.** Treat the numbers as a starting map, not current truth.

## Comparison method used

- Quick scalar estimate: `80/20 = 0.8 * input + 0.2 * output` per 1M tokens.
- Official OpenAI/Anthropic pricing was compared separately from RU intermediaries.
- User supplied FX rate in-session: `77.04 ₽ / $`.

## Baseline: ProxyAPI public pricing checked

Approximate 80/20 baselines from ProxyAPI public pages:

| Model | ProxyAPI input | ProxyAPI output | ProxyAPI 80/20 |
|---|---:|---:|---:|
| Claude Opus 4.8 / 4.7 / 4.6 | 1516 ₽ | 7579 ₽ | 2728.6 ₽ |
| Claude Sonnet 4.6 | 774 ₽ | 3866 ₽ | 1392.4 ₽ |
| GPT-5.5 | 1520 ₽ | 9100 ₽ | 3036 ₽ |
| GPT-5.4 | 760 ₽ | 4550 ₽ | 1518 ₽ |
| GPT-5.4 mini | 230 ₽ | 1370 ₽ | 458 ₽ |

## Candidates found

### AITUNNEL (`aitunnel.ru`)

Signals:
- Public legal page with ИП details, contract, bank requisites, ЭДО, invoices/acts.
- Explicit dev-tooling integrations: Claude Code, Codex CLI, Cursor, Cline, OpenCode, n8n, LangChain.
- OpenAI-compatible endpoint and RU docs.
- Reviews page existed; one review itself noted markup can reach 2.5–3× for some providers.

Example checked prices:

| Model | Input | Output | 80/20 | vs ProxyAPI |
|---|---:|---:|---:|---:|
| Claude Opus 4.8 | 700 ₽ | 3500 ₽ | 1260 ₽ | ~2.17× cheaper |
| Claude Sonnet 4.6 | 60 ₽ | 3000 ₽ | 648 ₽ | ~2.15× cheaper |
| GPT-5.5 | 100 ₽ | 6000 ₽ | 1280 ₽ | ~2.37× cheaper |
| GPT-5.4 | 50 ₽ | 3000 ₽ | 640 ₽ | ~2.37× cheaper |
| GPT-5.4 mini | 15 ₽ | 900 ₽ | 192 ₽ | ~2.39× cheaper |

Use case: strong first RU-dev-tools candidate; less cheap than some others, but better visible operational/legal surface.

### Polza AI (`polza.ai`)

Signals:
- Claims 400+ models, OpenAI-compatible API, docs, RU payment.
- Shows backend providers/routes per model (`openai`, `azure`, `anthropic`, `amazon-bedrock`, `drouter`, `mie`, etc.) with per-route prices and status.
- Important: cheap routes may not be official routes; label route explicitly.

Example checked prices:

| Model / route | Input | Output | 80/20 | vs ProxyAPI |
|---|---:|---:|---:|---:|
| GPT-5.5 | 501.085 ₽ | 3006.51 ₽ | 1002.2 ₽ | ~3.03× cheaper |
| GPT-5.4 OpenAI route | 250.542 ₽ | 1503.255 ₽ | 501.1 ₽ | ~3.03× cheaper |
| GPT-5.4 cheapest route seen (`mie`) | 98.058 ₽ | 784.776 ₽ | 235.4 ₽ | ~6.45× cheaper |
| Sonnet 4.6 Anthropic route | 300.651 ₽ | 1503.255 ₽ | 541.2 ₽ | ~2.57× cheaper |
| Sonnet 4.6 cheap route (`drouter`) | 69.381 ₽ | 69.381 ₽ | 69.4 ₽ | ~20× cheaper, high route-opacity caveat |
| Opus 4.8 Anthropic route | 501.085 ₽ | 2505.425 ₽ | 902.0 ₽ | ~3.03× cheaper |
| Opus 4.8 cheap route (`drouter`) | 138.762 ₽ | 138.762 ₽ | 138.8 ₽ | ~19.7× cheaper, high route-opacity caveat |

Use case: probably the most interesting price candidate after AITUNNEL, but route choice must be tested carefully.

### Chad API (`api.chadgpt.ru`)

Signals:
- ChadGPT brand; API v2 is OpenAI-compatible.
- Payment by Russian cards and invoices/accounts are advertised.
- Docs page says v2 uses OpenAI-compatible format and pay-as-you-go token billing; cache not counted at time of check.

Example checked public GPT prices:

| Model | Input | Output | 80/20 | vs ProxyAPI |
|---|---:|---:|---:|---:|
| GPT-5.5 | 320 ₽ | 1920 ₽ | 640 ₽ | ~4.74× cheaper |
| GPT-5.4 | 320 ₽ | 1920 ₽ | 640 ₽ | ~2.37× cheaper |

Use case: strong GPT/Codex candidate. Claude public prices were not fully verified in-session.

### BotHub (`bothub.chat`)

Signals:
- Russian platform, states it works since 2023.
- OpenAI-compatible gateway at `https://openai.bothub.chat/v1`.
- Corporate page: ЭДО, NDA, org cabinet, limits/analytics, prepayment.
- Pricing uses internal `Caps`; API/model page can show USD per 1M token under selected tariff, and corporate cap cost may be fixed by contract.

Example checked Elite API prices converted with 77.04 ₽/$:

| Model | Input USD | Output USD | 80/20 ₽ | vs ProxyAPI |
|---|---:|---:|---:|---:|
| GPT-5.5 | $5.63 | $33.75 | ~867 ₽ | ~3.5× cheaper |
| GPT-5.4 | $2.81 | $16.88 | ~433 ₽ | ~3.5× cheaper |

Use case: good corporate/UI/API option, but pricing model is less straightforward than plain token pricing.

### GenAPI (`gen-api.ru`)

Signals:
- ООО ИНФИМУМ, Skolkovo participant shown.
- OpenAI-compatible proxy endpoint for IDE/plugins: `https://proxy.gen-api.ru/v1`.
- Docs and IDE pages for Cursor/Cline/Kilo Code.
- Strong focus on images/video/functions as well as LLMs.

Example checked prices:

| Model | Input | Output | 80/20 | vs ProxyAPI |
|---|---:|---:|---:|---:|
| GPT-5.5 | 1250 ₽ | 7500 ₽ | 2500 ₽ | ~1.21× cheaper |
| GPT-5.4 | 625 ₽ | 3750 ₽ | 1250 ₽ | ~1.21× cheaper |
| Claude Sonnet 4.6 | 1250 ₽ | 6250 ₽ | 2250 ₽ | more expensive than ProxyAPI baseline |

Use case: not the best pure LLM-price alternative; consider for image/video/functions or Skolkovo/legal signals.

### API Glue (`apiglue.ru`)

Signals from browser page:
- B2B-looking API aggregation; OpenAI/Anthropic/Google/Yandex/Cloud; pay by Russian card or legal-entity invoice.
- Mentions failover/retry, load balancing, Langfuse analytics, n8n cloud, teams/roles.
- Public token prices were not found in-session.

Use case: promising B2B candidate, but requires pricing inquiry or logged-in check.

### GPTunneL

Found in secondary article as older Russian aggregator with business verification, postpay/prepay, small minimum top-up, and ScriptHeads connection. Direct site/pricing extraction failed in-session. Do not rank without direct verification.

### VseGPT (`vsegpt.ru`)

Signals:
- Long-running RU-facing aggregator/playground; search results and site claim work since 2023 and 120+ models.
- OpenAI-compatible API: `https://api.vsegpt.ru/v1` / `https://api.vsegpt.ru/v1/chat/completions`.
- Anthropic-compatible API beta for Claude Code at `https://services.vsegpt.ru:3000`; site has a Claude Code setup page and model mapping guidance.
- Russian cards/SBP via payment aggregators; no card binding; free test credits; email-only registration.
- Uptime page says ~99% text-generation success, but detailed stats are for registered users.
- Privacy claim: they do not store prompts, only billing stats, while upstream providers may log some elements.

Important pricing caveat:
- VseGPT prices text models in **rubles per 1000 characters**, not tokens. Do not compare directly to 1M-token prices.
- For rough conversion, show a range: 2–4 chars/token. In the July 2026 check, top GPT/Claude models were generally not cheaper than ProxyAPI after conversion.

Example checked prices per 1000 characters:

| Model | Input / 1K chars | Output / 1K chars |
|---|---:|---:|
| GPT-5.5 | 1.5 ₽ | 9 ₽ |
| GPT-5.4 | 0.70 ₽ | 4.20 ₽ |
| GPT-5.4 mini | 0.20 ₽ | 1.20 ₽ |
| Claude Sonnet 4.6 | 0.40 ₽ | 2.00 ₽ |
| Claude Opus 4.8 | 1.20 ₽ | 6.70 ₽ |

Use case: useful universal RU webchat/API playground and Claude Code experiment path; **not** a price leader for top LLM API workloads.

### RouterAI (`routerai.ru`)

Signals:
- Strong candidate for an RU LLM router/API infrastructure service rather than just a simple proxy.
- OpenAI-compatible base URL: `https://routerai.ru/api/v1`.
- Endpoints observed in docs/model pages: `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (Anthropic Messages-compatible), `/v1/keys` for key management.
- 402 models in catalog during check; prices shown in rubles per 1M tokens.
- Payment: card and bank transfer; public site says usable for legal entities and IPs.
- Legal surface: ООО «Интер», ИНН `7017351722`, ОГРН `1147017006950`, public offer, privacy policy, contact email/phone.
- Privacy policy: stores metadata (time, model, token counts, cost), says prompt/response content is not collected/stored by default; acknowledges cross-border transfer of prompt text to upstream model providers; says personal data storage uses RF servers and Roskomnadzor cross-border notice was filed.
- Routing controls via `provider`: `order`, `only`, `ignore`, `allow_fallbacks`, `country`. Useful for reproducibility and geo/policy constraints.

Extraction quirk:
- Some RouterAI pages returned 406 to `web_extract`, but browser rendering worked. Docs expose `https://routerai.ru/llms-full.txt` and docs pages include markdown links; use those for fast extraction.

Example checked prices:

| Model | Input | Output | 80/20 | vs ProxyAPI |
|---|---:|---:|---:|---:|
| GPT-5.5 | 501 ₽ | 3011 ₽ | 1003 ₽ | ~3.03× cheaper |
| GPT-5.4 | 250 ₽ | 1505 ₽ | 501 ₽ | ~3.03× cheaper |
| GPT-5.4 mini | 75 ₽ | 451 ₽ | 150.2 ₽ | ~3.05× cheaper |
| Claude Sonnet 4.6 | 301 ₽ | 1505 ₽ | 541.8 ₽ | ~2.57× cheaper |
| Claude Opus 4.8 | 501 ₽ | 2509 ₽ | 902.6 ₽ | ~3.02× cheaper |
| Claude Sonnet 5 | 200 ₽ | 1003 ₽ | 360.6 ₽ | no ProxyAPI baseline in session |
| DeepSeek V4 Pro | 61 ₽ | 122 ₽ | 73.2 ₽ | no ProxyAPI baseline in session |
| Gemini 3.1 Pro Preview | 200 ₽ | 1204 ₽ | 400.8 ₽ | no ProxyAPI baseline in session |

Use case: top shortlist candidate after this session. Treat as `router/API-infrastructure` profile: good for teams, keys, billing, failover, and provider selection. Still smoke-test Claude Code/OpenCode compatibility through `/v1/messages` before relying on it.

## Practical recommended test set

For a future paid smoke test across Polza + Chad + AITUNNEL (+ BotHub if corporate/UI matters):

1. Same short coding prompt with streaming.
2. Same JSON-schema/structured-output request.
3. Tool-calling/function-calling request.
4. Long-context request with repeated cached prefix if cache is advertised.
5. Claude Code / Codex CLI base URL compatibility where relevant.
6. Billing audit: compare dashboard charged tokens to local usage estimate.
7. Failure modes: rate limit, retry behavior, and provider fallback visibility.

Report results as: `price`, `latency`, `failures`, `feature compatibility`, `route transparency`, `billing trust`, `legal/docs`.
