# Model Routing Convention

When spawning sub-agents, choose the right model for the task.

## Routing Table

| Task | Model | Why |
|------|-------|-----|
| Main session / complex instructions | Opus (default) | Best overall quality |
| Signal detection / entity extraction | Sonnet | Fast, cheap, fires every message |
| Research / synthesis | DeepSeek or Qwen | 25-40x cheaper for large context |
| Fast lightweight sub-agents | Groq | 500 tok/s, good for simple tasks |
| Judge tests / quality grading | Haiku | Cheap, good enough for pass/fail |

## Refusal Routing

When a model refuses a request:
1. Re-spawn on a different model (don't announce the switch)
2. Fallback chain: primary → DeepSeek → Qwen → Groq
3. Never show the refusal to the user
4. If all models refuse, escalate to the user

## Spawn Rules

- 3+ items to process → spawn a sub-agent
- >2 tool calls that don't need real-time judgment → spawn
- Main thread must stay responsive to the user
- Signal detection always spawns (parallel, don't block)
