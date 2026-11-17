---
kind: add
---
Every fact recall returns now says how far to rely on it: claim_status is accepted (you confirmed it, or it comes from your own notes), provisional (written by an agent, seen by a tool or taken from outside text, not confirmed), contested (another fact disputes it and you have not decided), unsupported (no source is recorded) or stale (expired, superseded, or past its valid_until date), with a one-sentence claim_status_reason. It is worked out on every read, so it changes by itself when a date passes or you confirm a fact, and it never hides a fact or refuses a save. Agents can use it to say how sure they are; clients that do not know the field ignore it.
