# Salience + Recency on `gbrain query` (v0.29.1)

YOU ARE IN CHARGE of the `salience` and `recency` parameters on gbrain's
`query` op. They are TWO ORTHOGONAL axes — use either, both, or neither.

If you OMIT a parameter, gbrain auto-detects from query text via a
regex heuristic. The default for queries that don't match any pattern
is `'off'`. Prefer to pass values EXPLICITLY when you know what the
user wants.

## What each axis means

- `salience` — **mattering**. Boosts pages with high `emotional_weight`
  and many active takes. NO time component. Use when the user wants
  the most important / most-discussed pages on a topic, regardless of
  when they were updated.

- `recency` — **age**. Boosts pages with recent `effective_date`. NO
  mattering signal. Per-prefix decay (`concepts/`, `originals/`,
  `writing/` are evergreen; `daily/`, `media/x/`, `chat/` decay
  aggressively). Use when freshness is the signal.

## When to pass `salience='on'`

The "mattering" axis. The user wants what matters in this brain on
the topic, not the canonical encyclopedia entry.

- `"prep me for the widget-ceo meeting"` (meeting prep)
- `"catch me up on acme"` (conversation recall)
- `"what's going on with widget-co"` (current state matters)
- `"remind me about the deal"` (recall takes / opinions)
- `"what's been happening lately"`
- `"status update on X"`

Pair with `recency='on'` when current-state matters. Just `salience='on'`
alone gives you "what matters about X regardless of when."

## When to pass `recency='on'`

The "freshness" axis. The user wants recent content, with or without
mattering.

- `"latest news on AI"` (recent, no mattering needed)
- `"what's new this week"`
- `"recent updates on widget-co"`
- `"this week's announcements"`

Use `'strong'` when the user explicitly asks for the most recent:

- `"what happened today"`
- `"right now what's going on"`
- `"this morning"`

## When to pass BOTH `'off'`

The "canonical truth" axis. The user wants the authoritative answer.

- `"who is widget-ceo"` (entity lookup)
- `"what is widget-co"` (definitional)
- `"history of acme"` (historical research)
- `"explain how recursion works"` (concept query)
- `"tell me about widget-co"` (canonical recall)
- Code lookups: function/class names, syntax like `Foo::bar()` or `obj.method`
- Graph traversal: backlinks, inbound/outbound edges
- Anything not matching above

## Heuristic when unsure

> Current state → on. Canonical truth → off.

If you can't classify confidently, OMIT the param and let gbrain's
auto-detect handle it. The heuristic defaults to `off` for everything
that doesn't clearly match a current-state pattern. The `--explain`
output shows `_resolved.salience_source` and `_resolved.recency_source`
('caller' vs. 'auto_heuristic') so you can see what fired and why.

You can override at any time. gbrain is smart but not infallible. You
have context gbrain doesn't.

## Narrow temporal-bound exception

Even when a query matches canonical patterns, an explicit temporal
bound (`today`, `this week`, `right now`, `since X`, `last N days`)
overrides the canonical-wins rule:

- `"who is widget-ceo right now"` → recency = `'strong'`, salience = `'on'`
  (the temporal bound wins over "who is")
- `"who is widget-ceo"` → recency = `'off'`, salience = `'off'` (no bound)

## English-only

The auto-detect heuristic is English-only in v0.29.1. Non-English
queries fall through to the default `off` for both axes. Pass
`salience` and `recency` explicitly for non-English queries.

## Tuning the recency formula

Defaults are in `src/core/search/recency-decay.ts`. Override per-brain
via `gbrain.yml`:

```yaml
recency:
  daily/:
    halflifeDays: 7
    coefficient: 2.0
  custom-prefix/:
    halflifeDays: 30
    coefficient: 0.5
```

Or per-process via env: `GBRAIN_RECENCY_DECAY="prefix:halflife:coefficient,..."`.
The parser fails LOUD on bad syntax (no silent fallback).

## Date filtering with `since` / `until`

Independent of the axes. Filter to pages whose `effective_date` is
within a range:

- `since: '7d'` — last 7 days
- `since: '2024-06-01'` — ISO-8601
- `until: '2024-06-30'` — ends at end-of-day

`since`/`until` work with OR without `salience`/`recency`. Pure filter,
no boost.

## See also

- `docs/recency.md` — full reference
- `gbrain query --explain` — see resolved values + factor contributions
- `get_recent_salience` op gains `recency_bias: 'flat' | 'on'` — opt
  into per-prefix decay on the dedicated salience query
