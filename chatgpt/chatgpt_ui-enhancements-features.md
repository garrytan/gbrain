---
title: "UI Enhancements & Features"
type: note
created: 2026-03-05
updated: 2026-03-05
source: chatgpt-export
conversation_id: 69aa011c-c24c-8328-b91f-9971e574c3a9
message_count: 2
tags: [chatgpt, import, long-form]
---
# UI Enhancements & Features

> Conversation ID: 69aa011c-c24c-8328-b91f-9971e574c3a9
> Created: 2026-03-05T22:25:52Z
> Updated: 2026-03-05T22:26:18Z
> Messages: 2

---

## User

So I want all of the following broken out as bullet points. Issues that I'm going to give to Claude and ask it to open up issues in Linear. Or actually, if you could have access, you could do it directly, but, um, so the first thing is that anytime there's a table that contains entities that open up the right, um, drawer sidebar for that entity, um, we should be able to right-click on it and see a dropdown that contains the same exact dropdown menu as the actions dropdown menu from the drawer. Um, and that should open at the point that you right-click it. Um, the same thing should be true for um left sidebar nav items. If I right-click on the nav item, I should see the dropdown for that item. Anytime anything has an action menu, right-clicking should work that way. And then the same thing in the right sidebar, clicking anywhere in the right sidebar outside of a button or something should open up the actions menu for that item. The, um. And then we should get clever with consolidating some logic, like, if we have items in the entity right drawer that are copyable, which we have a lot of, like you can copy, click to copy. Profile URL, emails, phone numbers, and contacts and stuff, you can do it on label and ISRC codes. We should consolidate the logic there so that there then automatically becomes a copy menu with a sub-menu to copy to clipboard any of those items. And so those copied items are basically just automatically populated and generated whenever there's a copyable item in the sidebar, and that should all be like refactored for minimal duplication of code. This is a far out feature, don't need it right now, but an audit trail activity feed for probably all entities, honestly. That way for a profile, you can see if it's been edited and how. For a release, you can see if you would be able to see when more DSPs were added by the enrichment process and stuff. The same thing with the profile, and it could be like, Joby found another DSP, Joby found another DSP. And that could, you know, just keep populating that way. It's probably useful in releases for a DSP count or something to be in the releases table. And maybe the way to do that is, like, show a Spotify logo icon and then an Apple Music icon, and then say, like, plus 13 others, you know? And then if you hover it, we could do a tooltip that shows the icons and the DSP names that are matched. Maybe consolidate the language for those two to be platforms. It could be like, so on the tab it says platforms, and then we call them platforms and stuff instead of calling them DSPs, at least when it's user-facing. I agree. Demo page needs to use real components, and we need it to display releases, and then we also should do an audience page mocked with very, very data, because that's a really important one and is super interesting, so we should mock that with a bunch of data, and then update the demo page to have that, and then on the actual homepage, when we talk about audience, we can show that, and we should show it as like, or we can, yeah, we can show that demo in the audience section. And then the deep link grid that we had before should be put back on the homepage again beneath the rest of our features. And then, Overall homepage needs like massive front-end design work to clean up padding and... Everything generally feels like it could be smaller outside of the H1s and H2s. And better respect the design system, because it seems like it's just like showcasing a completely different product. None of it is matching the actual design system. And again, the example of the deep end, pull the actual album art, like go with, if it's on Google, calculate and combine the deep end, just go get the album art and put it in there and clean up that demo so that those, you know, DSP buttons are actually respecting our design. Like, we don't have shift whenever you hover something, and these things are shifting like crazy. And they have white borders, which doesn't match our design tokens. Like, everything should match design tokens. And the login methods, again, we're down to only two login methods now. It's just Google and email, so Google should always be the primary color and email should always be secondary, and we should remove any logic for sorting the auth methods.

---

## Assistant

**Context Menus / Right-Click Behavior**

- Implement a **universal right-click context menu system** for entities.  
- In any **table containing entities that open the right drawer sidebar**, right-clicking the row should open a context menu at the cursor location.  
- That context menu should contain **the same actions that exist in the entity’s drawer action dropdown**.  
- The same right-click behavior should apply to **left sidebar navigation items**, showing the dropdown actions for that item.  
- Any UI element that has an **actions dropdown menu** should also support **right-click to open the same menu at the cursor position**.  
- In the **right sidebar entity drawer**, right-clicking anywhere in the sidebar background (excluding buttons or interactive elements) should open the entity’s **actions menu**.  
- Refactor action menu logic so that **all context menus reuse a shared implementation**.

---

**Copyable Field System Refactor**

- Consolidate logic for **copyable fields** in entity sidebars.  
- Current examples include:  
  - Profile URL  
  - Emails  
  - Phone numbers  
  - Contacts  
  - Label codes  
  - ISRC codes  
- Implement a **generic “copy” system** where any field marked as copyable automatically populates a **Copy submenu in the entity actions menu**.  
- The submenu should list each copyable value with a **“Copy to clipboard” action**.  
- Ensure this system is **automatically generated from the sidebar fields** rather than manually defined.  
- Refactor implementation to **minimize duplicated code across entities**.

---

**Audit Trail / Activity Feed (Future Feature)**

- Add an **audit trail activity feed for entities** (future feature).  
- Likely applies to **all entity types** (profiles, releases, etc.).  
- Example events:  
  - Profile edited (show changes).  
  - Enrichment process adds new platforms.  
  - System events such as “Jovie found another platform.”  
- Activity feed should **append events over time** for transparency and debugging.

---

**Release Platform Visibility**

- Add a **platform count indicator in the releases table**.  
- Display **platform icons (e.g., Spotify, Apple Music)** inline.  
- Example display pattern:  
  - Spotify icon  
  - Apple Music icon  
  - “+13 others”  
- Hovering should show a **tooltip listing all matched platforms with icons and names**.

---

**Terminology Standardization**

- Standardize user-facing terminology from **“DSPs” to “Platforms.”**  
- Update UI labels accordingly:  
  - Tabs labeled **Platforms**.  
  - Tooltips and UI copy reference **Platforms**.

---

**Demo Page Improvements**

- The **demo page should use real production components**, not placeholder implementations.  
- Demo page should **display releases using the actual release components**.  
- Add a **mock Audience page** with rich fake data to demonstrate the feature.  
- Audience demo should include **large, interesting datasets** to showcase functionality clearly.  
- Update demo navigation to include this **Audience demo view**.

---

**Homepage Updates**

- In the **Audience section of the homepage**, embed or preview the **Audience demo UI**.  
- Restore the **deep link grid** beneath the features section of the homepage.

---

**Homepage Design Cleanup**

- Perform **major frontend design cleanup** on the homepage.  
- Reduce excessive padding and spacing.  
- Most UI elements should be **visually smaller and tighter**, except H1/H2 headings.  
- Ensure the homepage **fully adheres to the design system**.  
- Current homepage visuals appear to represent **a different product style** and need alignment with the actual UI system.

---

**Deep Link Demo Improvements**

- Update the **Deep End example** on the homepage:  
  - Fetch the **actual album artwork from Google**.  
  - Use the real artwork in the demo.  
- Ensure DSP/platform buttons:  
  - Follow **design tokens**.  
  - Do **not shift position on hover**.  
  - Do **not include white borders** that conflict with the design system.  
- All UI elements in the demo must **match the production component styling**.

---

**Authentication UI Simplification**

- Authentication methods are now limited to **two options**:  
  - Google  
  - Email  
- Google login should always appear as the **primary button**.  
- Email login should always appear as the **secondary button**.  
- Remove any **existing logic that dynamically sorts authentication methods**.
