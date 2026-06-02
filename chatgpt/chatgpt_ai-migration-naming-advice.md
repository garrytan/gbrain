---
title: "AI migration naming advice"
type: note
created: 2025-12-13
updated: 2025-12-13
source: chatgpt-export
conversation_id: 693cb700-e358-8329-b7fd-ae6595c1b62d
message_count: 4
tags: [chatgpt, import]
---
# AI migration naming advice

> Conversation ID: 693cb700-e358-8329-b7fd-ae6595c1b62d
> Created: 2025-12-13T00:44:49Z
> Updated: 2025-12-13T00:50:41Z
> Messages: 4

---

## User

{'asset_pointer': 'sediment://file_00000000744c71fda4608beb794c5d89', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 553, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 209900, 'width': 451}
Ai is naming these migrations. Is this bad?

---

## Assistant

Mr. White: technically **not bad**. Migration *contents* matter; the filename is mostly for humans.

That said, AI/random names like `0014_narrow_meltdown.sql` are **annoying** because they make reviews, debugging, and “what changed when?” harder.

What to do:

- **Best practice:** use a descriptive name: `0014_add_creator_contacts.sql`, `0015_add_profile_photo_policies.sql`, etc.
- **Important rule:** **don’t rename** a migration **after it has run anywhere** (staging/prod). Most migration systems treat the filename (or its recorded id) as part of tracking; renaming can cause drift or re-apply issues.
- If you want cleaner names, do it **at generation time** (most tools let you pass a name) or standardize a convention (prefix + short verb phrase, optionally a ticket id).

So: not dangerous, but I’d stop it before it scales.

---

## User

Create a prompt for our ai to update ruleset for naming migrations

---

## Assistant

Mr. White — here’s a ready-to-paste **system/developer prompt** you can give your AI so it enforces a strict migration naming ruleset.

---

### Prompt: Migration naming ruleset (for AI)

You are responsible for naming database migration files. Filenames must be predictable, human-readable, and reflect the schema change. **Do not use random/adjective-based names** (e.g., “narrow_meltdown”, “goofy_nightcrawler”). If you cannot confidently infer the change, you must request a descriptive name from the user.

#### Required filename format
`NNNN_<action>_<entity>[_<detail>].sql`

- `NNNN` = zero-padded sequential number (4 digits), increasing.
- All lowercase.
- Use `snake_case` only.
- Max 60 characters after the numeric prefix (keep it short).
- Only letters, numbers, underscores.

#### Allowed actions (choose one)
`create | add | alter | rename | drop | backfill | index | constraint | policy | seed | fix`

#### Entity and detail rules
- `entity` is the primary table/object affected (plural for tables): `users`, `creator_contacts`, `profile_photos`, etc.
- `detail` clarifies the main change: `deleted_at`, `dedup_key`, `unique_email`, `rls_select`, etc.
- Prefer **what changed** over **why**.
- If multiple entities are touched, pick the primary one and include a concise detail: `add_fk_orders_user_id`.

#### Examples (good)
- `0014_add_deleted_at_to_users.sql`
- `0015_create_creator_contacts.sql`
- `0016_add_unique_index_on_users_email.sql`
- `0017_backfill_dedup_key_on_profiles.sql`
- `0018_add_rls_policy_profile_photos_select.sql`

#### Examples (bad)
- `0014_narrow_meltdown.sql`
- `0015_goofy_nightcrawler.sql`
- `add_stuff.sql`
- `migration_final.sql`

#### Decision process you must follow
1. Identify the primary change type (table create/alter/index/policy/backfill/etc.).
2. Identify the primary entity affected.
3. Identify the smallest accurate detail phrase.
4. Produce the filename in the required format.
5. If ambiguity remains, ask exactly one question:  
   “What is the primary schema change (e.g., add column X to table Y / create table Z / add index on A(B))?”

Return only the final filename (unless you must ask the question).


## See Also
- [[chatgpt/chatgpt_brand-naming-suggestions]]
- [[chatgpt/chatgpt_component-naming-guidance]]
- [[chatgpt/chatgpt_rp-app-naming-ideas]]
- [[chatgpt/chatgpt_accident-insurance-exchange-advice]]
- [[chatgpt/chatgpt_airport-gun-disposal-advice]]
