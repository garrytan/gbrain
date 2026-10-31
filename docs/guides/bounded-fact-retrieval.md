# Bounded retrieval for individual facts

The default fact backfill refuses facts over the active model's input limit.
Trusted in-process callers can explicitly select a partial retrieval strategy:

```ts
await embedStaleFacts(engine, {
  sourceId: 'default', yes: true, maxCostUsd: 1,
  oversizedStrategy: 'bounded-prefix',
});
```

This option belongs to the local TypeScript API. CLI and owner-proxy wire
options retain their default refusal policy. Omit the option, or select
`'refuse'`, to retain that policy in process as well.

For an oversized fact, `bounded-prefix` sends the longest Unicode code-point
prefix whose UTF-8 byte length fits the effective token cap. This conservative
bound also bounds estimated tokens. The vector covers only that prefix;
information in the tail has no semantic retrieval coverage from this vector.
Ordinary facts use their normal embedding inputs.

The stored fact text is never edited. Its complete text hash remains the
freshness identity, so a later edit anywhere in the fact makes the vector
stale. The existing source-incarnation, revision, withdrawal, model identity,
embedding policy and spend guards also apply to partial representations.
After each committed batch, stderr identifies each fact and source that
received a partial retrieval representation. Existing result counts include
these as embedded facts; no result fields are added. Preview counts selected
oversized facts as work, without sending text or spending money.
