# Takes Vs Facts

Cortex keeps two epistemological layers because real company knowledge has both
fast conversational memory and slower attributed beliefs.

## Takes

Takes capture attributed beliefs, bets, hunches, and claims from source
material. They are retrospective and source-grounded.

Examples:

- `holder=people/alex-founder kind=bet` "AI will replace 50% of coding by 2030"
- `holder=people/jordan-customer kind=take` "The renewal blocker is security review"
- `holder=world kind=fact` "Clipboard raised a Series C"
- `holder=brain kind=hunch` "The sales cycle is blocked by procurement"

Query surface: `cortex takes list`, `cortex takes search`, `cortex think`.

## Facts

Facts are hot tenant memory captured from authenticated conversations.

Examples:

- `kind=event` "I have a meeting with Brian tomorrow"
- `kind=preference` "Use terse launch updates"
- `kind=commitment` "We decided on nested custody"
- `kind=belief` "I think the market is overheated"

Query surface: `cortex recall` and MCP hot-memory metadata.

## Category Rule

Do not dump takes into facts: takes may include other people's attributed
beliefs. Do not dump facts into takes without attribution and consolidation.

## Bridge

The consolidation cycle can promote durable facts into takes with holder,
weight, deduplication, and temporal context.

Key extraction lessons:

1. Holder is not always subject.
2. Split compound claims.
3. Amplification is not endorsement.
4. Self-reported is not automatically verified.
5. Use calibrated weights, not false precision.
6. Skip trivia that fails the "so what" test.
