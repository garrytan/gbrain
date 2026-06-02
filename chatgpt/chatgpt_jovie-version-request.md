---
conversation_id: 69f00f53-20e0-83e8-b087-9dc8acbdbb7c
created: 2026-04-28
links:
- '[[chatgpt-clusters/jovie_product_strategy]]'
message_count: 5
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Jovie version request
type: guide
updated: 2026-04-28
---

# Jovie version request

**Related:** [[jovie_music]]

> Conversation ID: 69f00f53-20e0-83e8-b087-9dc8acbdbb7c
> Created: 2026-04-28T01:37:24Z
> Updated: 2026-04-28T02:10:53Z
> Messages: 5

---

## User

{'asset_pointer': 'sediment://file_00000000238471fdb695ba522380f071', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1230, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 570156, 'width': 1321}
Give me the jovie version of this. 

---

## Assistant

Mr. White, here’s the Jovie version of that pricing section. Free and Pro are grounded in the current Jovie pricing structure; Team and Enterprise are proposed expansions for the same four-card layout. citeturn392475view0

# Plans designed for how you release.

Monthly / Annually — Save 20%

| Plan | Price | Positioning | CTA |
|---|---:|---|---|
| **Free** | **$0** | For artists building their first release hub | **Start Free** |
| **Pro** | **$39/mo** | For active artists releasing and reactivating fans | **Start Pro Trial** |
| **Team** | **$99/mo** | For managers, marketers, and indie labels | **Start Team Trial** |
| **Enterprise** | **Custom** | For labels, distributors, and large rosters | **Book a Meeting** |

## Free  
**For basic artist presence**  
**$0**

Build your artist profile, smart links, and release pages without adding another tool to your stack.

**Free plan includes**

- Unlimited smart links  
- Auto-sync from Spotify  
- Smart deep links  
- Release pages with DSP links  
- Short link redirects  
- Public artist profile  
- Up to 100 captured contacts  
- 30-day analytics  

**CTA:** Start Free  
**Footer link:** View all features ↘

---

## Pro  
**For active artists**  
**$39 / month**

Turn profile visits into a fan list, then notify fans automatically every time a song, show, or ask goes live.

**Everything in Free, plus**

- Release notifications to fans  
- Pre-save campaigns  
- Pre-release and countdown pages  
- Unlimited contacts  
- Fan CRM  
- Email campaigns  
- 180-day analytics  
- Geographic insights  
- AI pitch generation  
- Priority support  

**CTA:** Start Pro Trial  
**Badge:** Most Popular  
**Footer link:** View all features ↘

---

## Team  
**For managers and indie labels**  
**$99 / month**

Manage multiple artists, campaigns, links, and fan loops from one shared workspace.

**Everything in Pro, plus**

- Multiple artist workspaces  
- Team seats and permissions  
- Shared release calendar  
- Cross-roster analytics  
- Approval workflows  
- Shared asset library  
- Custom domains  
- White-label profiles  
- Priority onboarding  

**CTA:** Start Team Trial  
**Footer link:** View all features ↘

---

## Enterprise  
**For labels, distributors, and agencies**  
**Custom**

Scale Jovie across large rosters with security, integrations, reporting, and dedicated support.

**Everything in Team, plus**

- Unlimited artist workspaces  
- Single sign-on  
- Admin controls  
- API access  
- Webhooks  
- Custom integrations  
- Dedicated success manager  
- Custom reporting  
- Security review  
- Custom contract terms  

**CTA:** Book a Meeting  
**Footer link:** View all features ↘

Suggested section subhead:

**Start with the profile. Upgrade when you’re ready to capture fans, notify them, and bring them back for every release.**

---

## User

generate a mockup for the homeapge

---

## User

{'asset_pointer': 'sediment://file_00000000436c71fd9a82c416a6657469', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 759, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 705023, 'width': 1265}
Build me a section like this. You know, generous white space and stuff, but make it based off of blues and make it say Jovie connects the moments that build an artist.

---

## Assistant

Mr. White, here’s a ready-to-drop section in the same spirit: sparse layout, large type, blue orbital background, simple CTA.

```html
<section class="jovie-moments-section">
  <div class="jovie-moments-content">
    <h2>Jovie connects the moments that build an artist.</h2>

    <a href="/pricing" class="jovie-moments-cta">
      Explore Plans
      <span>→</span>
    </a>
  </div>

  <div class="jovie-orbital-bg" aria-hidden="true">
    <div class="jovie-ring ring-one"></div>
    <div class="jovie-ring ring-two"></div>
    <div class="jovie-ring ring-three"></div>
  </div>
</section>
```

```css
.jovie-moments-section {
  position: relative;
  overflow: hidden;
  min-height: 720px;
  padding: 160px 7vw;
  background:
    radial-gradient(circle at 78% 42%, rgba(42, 116, 255, 0.28), transparent 34%),
    radial-gradient(circle at 84% 76%, rgba(0, 204, 255, 0.16), transparent 34%),
    linear-gradient(135deg, #020714 0%, #050a1f 42%, #0a1231 100%);
  border-radius: 0 0 12px 12px;
  color: #ffffff;
}

.jovie-moments-content {
  position: relative;
  z-index: 2;
  max-width: 620px;
}

.jovie-moments-content h2 {
  margin: 0;
  max-width: 560px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: clamp(44px, 5vw, 78px);
  line-height: 0.94;
  letter-spacing: -0.065em;
  font-weight: 700;
}

.jovie-moments-cta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 36px;
  padding: 13px 22px;
  border: 1px solid rgba(190, 215, 255, 0.28);
  border-radius: 999px;
  color: #ffffff;
  text-decoration: none;
  font-size: 15px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.035);
  backdrop-filter: blur(12px);
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
}

.jovie-moments-cta:hover {
  transform: translateY(-1px);
  border-color: rgba(120, 180, 255, 0.72);
  background: rgba(62, 130, 255, 0.14);
}

.jovie-orbital-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.jovie-ring {
  position: absolute;
  right: -17vw;
  top: 8%;
  width: 760px;
  height: 760px;
  border-radius: 50%;
  border: 2px solid rgba(95, 196, 255, 0.42);
  box-shadow:
    0 0 26px rgba(78, 173, 255, 0.32),
    inset 0 0 36px rgba(78, 173, 255, 0.18);
  background:
    radial-gradient(circle at 40% 36%, rgba(105, 154, 255, 0.18), transparent 36%),
    radial-gradient(circle at 62% 66%, rgba(0, 194, 255, 0.12), transparent 42%);
  opacity: 0.95;
}

.ring-one {
  transform: rotate(-18deg) scale(1.05);
}

.ring-two {
  top: 23%;
  right: -10vw;
  transform: rotate(-14deg) scale(1.02);
  opacity: 0.72;
}

.ring-three {
  top: 61%;
  right: -7vw;
  transform: rotate(-10deg) scale(1.08);
  opacity: 0.58;
}

.jovie-moments-section::after {
  content: "";
  position: absolute;
  inset: auto 0 0;
  height: 190px;
  background: linear-gradient(to top, rgba(0, 3, 14, 0.92), transparent);
  pointer-events: none;
}

@media (max-width: 900px) {
  .jovie-moments-section {
    min-height: 620px;
    padding: 120px 28px;
  }

  .jovie-ring {
    right: -420px;
    top: 22%;
    width: 680px;
    height: 680px;
  }

  .ring-two {
    right: -360px;
    top: 35%;
  }

  .ring-three {
    right: -330px;
    top: 66%;
  }
}
```

Optional tighter copy variants:

```text
Jovie connects every moment that builds an artist.
```

```text
Jovie connects the releases, fans, and moments that build an artist.
```

```text
Jovie turns artist moments into fan momentum.
```


**Topic:** [[chatgpt-clusters/jovie_music]]
