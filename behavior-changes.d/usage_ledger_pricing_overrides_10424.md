---
kind: fix
---
The chat usage ledger behind get_usage now prices each call with the operator's pricing.overrides (set by gbrain pricing set), the same rate the budget meter uses, instead of recording calls to a model the shipped price table does not know as unpriced. An override for a model the table does know also wins there, as it does for the meter. A failed read of the overrides is retried on the next call rather than kept for a minute, closing the brain waits up to five seconds for rows still being written, rows written before the upgrade are not changed, and a model with no price anywhere still records no cost.
