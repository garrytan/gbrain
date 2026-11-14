**The skill resolver now leaves its skills block out when no skill fits the message, instead of showing one on every turn.**

### Fixed
- `gbrain skills resolve`, the hook lane, and the OpenClaw and Pi plugins apply `top_gate` by default (0.6): a block whose best skill only matches weakly is left out (`block_reason: weak_top_match`), and a skill named in the message still gets through. On harness-evals' public set P with its 351-skill catalog, blocks on requests that need no skill drop from 61 of 61 to 7 of 61, and the acceptable skill stays in the block for 174 of 228 skill requests (176 before). `skills.resolver.top_gate 0` restores the old behavior.
- `gbrain skills resolve` and the OpenClaw and Pi plugins now read `skills.resolver.top_gate` (and `per_harness.<harness>.top_gate`); before, only the hook lane did. `--top-gate` still wins on the command line.

<!-- behavior-change: skill_resolver_gate_default_gst2704 -->
