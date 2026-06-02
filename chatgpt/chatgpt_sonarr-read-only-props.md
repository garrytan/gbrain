---
title: "Sonarr Read-Only Props"
type: note
created: 2026-01-31
updated: 2026-02-01
source: chatgpt-export
conversation_id: 697e96ce-833c-8333-9cde-abac09fadcbc
message_count: 4
tags: [chatgpt, import]
---
# Sonarr Read-Only Props

> Conversation ID: 697e96ce-833c-8333-9cde-abac09fadcbc
> Created: 2026-01-31T23:57:23Z
> Updated: 2026-02-01T00:03:28Z
> Messages: 4

---

## User

Sonarr is flagging like 400+ files that need read-only. Um, should we add a read-only wrapper to all component props?

---

## Assistant

Mr. White, probably **don’t blanket-wrap every component’s props with `Readonly<>`** just to satisfy Sonar—400+ hits usually means a rule like “prefer readonly parameter types” is being applied mechanically to React function components.

### Why not do it everywhere?
- It’s **mostly noise**: React props are *conventionally immutable* already, and most teams don’t mutate props anyway.
- `Readonly<T>` is **shallow** (it stops `props.x = …`, but not deep mutations inside nested objects unless you use a deep-readonly type).
- It clutters signatures and diffs without much practical safety gain.

### Better options (pick one)
1. **Tune the rule** (recommended)
   - Configure Sonar/ESLint to **ignore React component props** (or ignore function parameters in `.tsx`), or limit the rule to places where mutation is a real risk (services, reducers, utilities).

2. **Use a single local convention when you care**
   - Only apply `Readonly<>` on components that accept **object-y props** that are tempting to mutate (filters, config objects, complex models).

3. **If you *must* satisfy Sonar with minimal churn**
   - Add a lightweight alias and apply it consistently:
     - `type RO<T> = Readonly<T>;`
     - then `function MyComp(props: RO<MyProps>) { … }`
   - This keeps it mechanical + readable and makes a codemod feasible.

### Quick litmus test
- If the rule is catching **actual bugs** (people mutating props), enforce it (or enforce immutability of the specific fields).
- If it’s just mass “style” warnings, **retune/disable for React props**.

If you tell me whether this is **SonarQube/SonarCloud** or an **ESLint rule** (and which rule name/ID is in the warning), I can give the exact config change to kill the noise without losing useful checks.

---

## User

URL encryption key should be the same or different between production and staging environment.

---

## Assistant

Mr. White, it should be **different** between production and staging.

**Why:**
- **Blast radius:** if staging leaks (it often has weaker controls), a shared key would also compromise production tokens/links.
- **Environment separation:** staging shouldn’t be able to decrypt/forge production URLs (and vice versa).
- **Safer rotation/testing:** you can rotate or experiment in staging without risking prod.

**When would “same key” ever make sense?**
- Only if you **intentionally require** URLs generated in staging to be valid in prod (or the reverse). That’s usually a smell. If you truly need this, a safer pattern is:
  - include an **env/audience** claim in the payload and validate it, and/or
  - use **key versioning** + strict issuer/audience checks, and/or
  - have prod accept only prod-issued tokens even if the crypto key matches.

**Practical guidance**
- Store keys in a **secret manager/KMS**, not env vars in repo.
- **Rotate** periodically; support multiple active key versions for smooth rollout.
- Don’t put long-lived secrets in URLs; keep tokens **short TTL** and scoped.

If you tell me what you mean by “URL encryption key” (e.g., Laravel `APP_KEY`, Rails `secret_key_base`, JWT/HMAC signing secret, or something custom), I’ll give the exact best-practice setup for that stack.


**Topic:** [[chatgpt-clusters/business_startup]]
