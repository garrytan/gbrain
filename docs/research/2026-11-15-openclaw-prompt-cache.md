# Moving gbrain's per-turn context to protect OpenClaw's prompt cache (shelved, 2026-11-15)

- **We learned that current OpenClaw already keeps gbrain's per-turn text from rewriting the cached conversation.** It pins the session system prompt and appends a changed section to history as an update message.
- **We learned that a direct-API probe overstated the problem.** It showed about 7,500 tokens written to the cache per turn; a real session showed hundreds. You should judge a context engine's cache cost on a real host session, not on hand-built payloads.

## Question

gbrain's OpenClaw context engine adds changing blocks (time, place, brain context) every turn. Does that force the model provider to rewrite the whole cached conversation each turn, and would moving the changing blocks into the newest user message fix it?

## What was tried

- **Probe**: direct-API payloads shaped like OpenClaw's requests, comparing block orders.
- **Fix ("route A")**: gbrain registers OpenClaw's public `before_prompt_build` hook and returns the changing blocks as context in front of the newest user message, leaving only the stable core in the system prompt. Built locally, never pushed.
- **Real session**: OpenClaw `e24d2c1`, Claude Opus 5.5, 20 turns including 7 tool turns, one run per arm (no gbrain, master, fix). Bar set in advance: the fix cuts cache-write tokens per user turn by 70% against master.

## Results

| Arm | Cache-write tokens per user turn, turns 3 to 20 |
|---|---|
| No gbrain | 234 |
| Master | 559 (1,808 with OpenClaw's memory flush) |
| Fix | 371 |

The fix came out 34% below master on the no-flush figure, against the 70% bar. The probe's ~7,500 tokens per turn didn't hold up: OpenClaw has pinned the session system prompt on Claude routes since openclaw#163461 (2026-10-02) and on every route since openclaw#198100 (2026-11-13). Master's update messages add about 609 characters of history per turn, so they may trip OpenClaw's pre-compaction flush sooner; that wasn't traced. The fix also had a bug (a notice repeated every turn).

Source: internal report (refs GST-2769, GBRA-539); the unpushed patch is kept with it.

## Decision and why

Shelved; nothing shipped. The real-session saving missed the bar, and the cost the fix targeted was mostly already gone on current OpenClaw.

## Cost

$6.03 for the probe and $3.41 for the real sessions in model runs, plus about $20 of model use for the thread.

## What would reopen it

- Evidence that master's per-turn update messages trigger compaction flushes often in real use (the 1,808 figure), or a host that doesn't pin the system prompt.
