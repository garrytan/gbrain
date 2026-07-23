# MiniMax Chat Models

GBrain exposes `MiniMax-M3` and `MiniMax-M2.7` through two compatible chat
recipes. Both use `MINIMAX_API_KEY` and preserve the existing `minimax:embo-01`
embedding configuration.

## OpenAI-Compatible Recipe

Select a model and choose either published region:

```bash
export MINIMAX_API_KEY=...
gbrain config set chat_model minimax:MiniMax-M3

# Global
gbrain config set provider_base_urls.minimax https://api.minimax.io/v1

# China
gbrain config set provider_base_urls.minimax https://api.minimaxi.com/v1
```

Use `minimax:MiniMax-M2.7` to select the second registered model.

## Anthropic-Compatible Recipe

The public base URL must end in `/anthropic`. GBrain derives the SDK's internal
`/v1` segment and does not expose that derived path as configuration.

```bash
export MINIMAX_API_KEY=...
gbrain config set chat_model minimax-anthropic:MiniMax-M3

# Global
gbrain config set provider_base_urls.minimax-anthropic https://api.minimax.io/anthropic

# China
gbrain config set provider_base_urls.minimax-anthropic https://api.minimaxi.com/anthropic
```

Verify the selected path with:

```bash
gbrain providers test --touchpoint chat
```
