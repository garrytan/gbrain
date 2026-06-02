---
title: "Link in bio improvements"
type: guide
created: 2025-08-21
updated: 2025-08-21
source: chatgpt-export
conversation_id: 68a7933c-1c4c-8328-a32c-457eee4c0bd7
message_count: 2
tags: [chatgpt, import, code]
---
# Link in bio improvements

> Conversation ID: 68a7933c-1c4c-8328-a32c-457eee4c0bd7
> Created: 2025-08-21T21:44:51Z
> Updated: 2025-08-21T21:47:54Z
> Messages: 2

---

## User

Analyze all the top link in bio products data models and suggest imrpovements to how jovie handles it

---

## Assistant

Mr. White — here’s a tight, model-level teardown and a v2 schema for Jovie, grounded in what the top link-in-bio + smart-link players actually support.

# What leaders model (patterns to copy on purpose)
- **Block-based pages** (sections, collapsibles, carousels, embeds) rather than flat “links arrays.” Beacons and Lnk.Bio expose blocks, collapsible groups, countdowns, scheduled visibility, and per-link analytics/actions. citeturn1search8turn1search0turn1search2turn1search10  
- **Scheduling & state per link** (show/hide windows). Linktree implements scheduled visibility at link level; also quick hide/inactive. citeturn2search1turn2search5
- **First-class analytics + UTM templates** (global + per link), plus GA exports. Linktree supports Insights, GA, and UTM parameters; Linkpop markets “free analytics” per link/page. citeturn2search4turn2search24turn2search0turn0search2turn0search14
- **Pixels & remarketing IDs** at the link/board level (FB, Google, TikTok, Snap). Linkfire exposes pixel integrations and custom params for richer audiences. citeturn2search11turn2search7turn2search19
- **Conditional routing / auto-redirect rules** by device, geo, referrer, or “preferred service cookie.” Linkfire and Feature.fm both ship this; FFm also deep-links into apps and remembers service preferences. citeturn0search9turn0search10turn0search4
- **Music-specific normalization** (ISRC/UPC input, rescan, pre-save → release auto-convert, DSP mapping). Linkfire + Feature.fm do this; Odesli/Songlink provides cross-platform resolution. citeturn0search3turn0search21turn0search16turn0search11
- **Embedded commerce** (Shopify Linkpop sells directly on page). Model products/variants or external checkout bindings. citeturn0search2turn0search20
- **Templating/themes & duplication** (fast page cloning, theme tokens). Lnk.Bio supports page duplication; Carrd shows sectioned builds + embed code for power users. citeturn1search22turn1search3turn1search11

---

# Jovie data model (v2) — concise schema
Design goal: compile to a static “published artifact” for sub-100 ms edge delivery, with minimal client JS.

### 1) Accounts, orgs, roles
```
accounts(id, email, created_at, plan, status)
workspaces(id, name, owner_account_id)
workspace_members(workspace_id, account_id, role)  -- owner, admin, editor, analyst
```

### 2) Profiles (public pages)
```
profiles(id, workspace_id, handle, display_name, avatar_url, bio, theme_id,
         is_public, canonical_url, published_version_id, default_locale, created_at)
themes(id, name, tokens_json)  -- color, radius, type scale, button variants
```

### 3) Blocks (ordered, typed, flexible)
```
blocks(id, profile_id, parent_block_id, kind, order_index, props_json,
       visible_from, visible_until, is_active)
-- kind examples: "links", "group", "embed", "carousel", "email_capture",
-- "storefront", "tipjar", "release", "music_smartlink", "event_list", "html"
```
Props are **typed JSON** (validated via zod): titles, layout variant, images, etc. Supports **collapsible**, countdown, and per-block **A/B variant keys**—parity with Beacons/Lnk.Bio features. citeturn1search8turn1search10

### 4) Links (child of “links” or within other blocks)
```
links(id, block_id, title, url, icon, image_url,
      utm_template_id, redirect_rule_id, a11y_label, order_index,
      is_active, visible_from, visible_until)
utm_templates(id, name, source, medium, campaign, content, term)  -- defaults at profile
```
Linktree-style **scheduling** + **UTM presets** at page & link level. citeturn2search1turn2search0

### 5) Routing & deep links
```
redirect_rules(id, name, match_json, action_json)
-- match_json: [{if: {country:'US', device:'ios', returning:true}}, ...]
-- action_json: {type:'redirect', url:'...', dsp:'spotify', deep_link:true, remember_service:true}
```
Covers Linkfire/Feature.fm **conditional redirects**, **preferred-service memory**, and **deep linking**. citeturn0search9turn0search10turn0search4

### 6) Music normalization (Jovie’s edge)
```
releases(id, workspace_id, type, title, artist_credit, artwork_url,
         upc, isrc, release_date, label, metadata_json)
release_targets(id, release_id, service, territory, url, deeplink_url, last_checked_at, status)
presaves(id, release_id, service, start_at, end_at, status)  -- auto-convert flag
```
- Accept **UPC/ISRC**, auto-fetch/resolve targets (Odesli ingestion + rescan tasks), and support **pre-save → released auto-convert**. citeturn0search3turn0search21turn0search16turn0search11

### 7) Commerce bindings (optional now, future-proof)
```
payment_accounts(id, workspace_id, provider, account_ref, status)
products(id, workspace_id, external_ref, title, price_cents, currency, image_url, metadata_json)
product_links(product_id, profile_id or block_id)   -- for Linkpop-style shoppable links
```
citeturn0search2turn0search20

### 8) Pixels & integrations
```
integrations(id, workspace_id, kind, name, config_json) -- GA4, Meta, TikTok, Snap, Mailchimp, Shopify, Stripe
profile_integrations(profile_id, integration_id, scope, props_json)
retarget_params(id, profile_id, platform, params_json)
```
Make **pixels attachable at profile or block**; pass **custom retargeting params** like Linkfire. citeturn2search11turn2search7turn2search19

### 9) Analytics (event store + rollups)
```
events(id, profile_id, block_id, link_id, type, ts, ip_hash, ua_hash,
       referrer, country, device, dsp, utm_json)
daily_rollups(profile_id, date, views, clicks, ctr, by_link_json, by_country_json)
```
Exports/bridges to **GA/UTM** and in-app Insights (Linktree/Linkpop parity). citeturn2search24turn2search4turn0search14

### 10) Versioning & publishing for <100 ms
```
profile_versions(id, profile_id, created_at, editor_id, diff_summary)
published_artifacts(id, profile_id, version_id, locale, json_blob, html_blob, published_at, cdn_key)
```
On publish: **compile** profile → a single, minified **artifact** (HTML+JSON) with images pre-sized; cache at edge. (Carrd + Lnk.Bio “duplicate/sections” workflows are supported via versions and cloning.) citeturn1search22turn1search3

---

## Why this improves Jovie immediately
- **Speed**: rendering from `published_artifacts` means read-one-row → stream HTML; links/blocks are already flattened. (Your sub-100 ms target becomes table stakes.)
- **Power without complexity**: blocks+links+rules keep the authoring simple but allow everything competitors do (schedules, collapsibles, countdowns, deep links, store, email capture).
- **Music edge**: first-class `releases` + `release_targets` with UPC/ISRC, rescan, pre-save auto-convert beats generic link stacks. citeturn0search3turn0search21turn0search16
- **Attribution**: UTMs, GA, pixels, and retarget params are native; no hacky query-string munging. citeturn2search0turn2search24turn2search19

---

## Minimal-risk migration plan (Supabase)
1) Add new tables alongside current ones; build **compiler** that reads old shape → writes `published_artifacts`.  
2) Flip public routes to serve compiled artifacts; keep authoring UI on old schema.  
3) Backfill core features: `utm_templates` → per-link UTM; `redirect_rules` for basic geo/device.  
4) Introduce `releases` for music creators; wire Odesli → `release_targets`; add “rescan” job. citeturn0search11turn0search21  
5) Move pixels/GA to `integrations` and expose checklists in UI (GA ID, Meta pixel, TikTok, etc.). citeturn2search24turn2search11  
6) Ship `profile_versions` + “Duplicate page” action to accelerate setup. citeturn1search22

---

## Guardrails & indexes (brief)
- Public RLS: make `published_artifacts` world-readable; everything else owner-scoped.  
- Index `events(profile_id, ts)`, `links(block_id, order_index)`, `blocks(profile_id, order_index)`.  
- CDN keys per artifact; pre-generate image sizes (thumb, card, hero) and store in props to avoid runtime transforms.

If you want, I’ll translate this into exact Supabase SQL + zod schemas next.


**Topic:** [[chatgpt-clusters/code_review]]


## See Also
- [[chatgpt/chatgpt_link-manager-improvements]]
- [[chatgpt/chatgpt_behance-link-in-bio]]
- [[chatgpt/chatgpt_best-link-in-bio-tools]]
- [[chatgpt/chatgpt_bio-link-explanation]]
- [[chatgpt/chatgpt_bio-link-strategy-part1]]
