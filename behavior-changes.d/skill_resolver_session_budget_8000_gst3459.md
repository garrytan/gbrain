---
kind: default
---
The skill resolver's per-session budget for skill lists, skills.resolver.session_token_budget, now defaults to 8,000 tokens instead of 2,000. At 2,000 a long session ran out around its twentieth turn and then stopped offering skills; at 8,000 it lasted all 30 turns of the measured sessions. It applies to every caller that reads the default: the Claude Code, Codex and Hermes hooks, the OpenClaw plugin, the Pi extension and gbrain skills resolve. A list still counts against the budget the same way, and a session still shows fewer skills as it spends more. To keep the old limit, run gbrain config set skills.resolver.session_token_budget 2000.
