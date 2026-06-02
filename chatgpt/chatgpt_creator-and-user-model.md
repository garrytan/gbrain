---
title: "Creator and user model"
type: guide
created: 2025-12-10
updated: 2025-12-10
source: chatgpt-export
conversation_id: 6938f278-3410-832f-82a4-d624ac127a0d
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# Creator and user model

> Conversation ID: 6938f278-3410-832f-82a4-d624ac127a0d
> Created: 2025-12-10T04:09:29Z
> Updated: 2025-12-10T04:10:48Z
> Messages: 2

---

## User

So, as we're building Joby, link in bio, features, you know, at MVP, you sign up for an account and you got your creator profile and that's it, right? Eventually, we want someone to be able to manage multiple creators, right? So, they might have, you know, you might be Ryan Tedder and you might also have the OneRepublic account, right? So, you might want a Ryan Tedder link in bio and a OneRepublic link in bio, but you want to have one login, right? So, maybe we'll then let you do that. And then eventually, we want to have, you know, you might be Ryan Tedder and you might own the Ryan Tedder account and the OneRepublic account, but you might have a manager who has, you want to have access to both of those. You might have an agent, you want your agent to be able to update your tour dates and stuff on there. So, they might have access to it, right? And then you'll have, basically, you'll have, you know, teams and stuff and then you might have a team organization account where it's like, okay, this management company or, you know, William Morris might have an account and their entire roster of creators is on there. But each one of those creators individually owns their thing and they each have managers and stuff. And a new employee joins William Morris, they get an account on Joby and then they also automatically get added to the William Morris organization and then as a result, they get access to all of the creators on it. So, that's where we're heading eventually, but just the question I have as we think about going towards that in the future is, you've got, you know, a creator signs up right now and, you know, we ask them for a bunch of stuff. One of the things we do is we, you know, we make a creator profile in the database on one table and we make a user table separately, right? And we have the ability right now to create creators in the backend as an admin. We can create creators that aren't tied to a user so that, and then send them a claim link and then they can go and claim it, right? When a user signs up right now, we ask them their name and we ask them to upload a photo or we grab the photo from their login method or whatever, set that as the user photo. I'm trying to figure out how to handle creator photos. Ideally, I don't want to ask this person to upload a photo twice, but I also don't want, you know, Ryan Tedder, say, signs up for an account and we're only in our current MVP phase where there's one user and one creator is all you can sign up for, and let's say Ryan Tedder signs up and wants to make the OneRepublic account, I don't want to be, I'm trying to figure out just like how to handle it where it's like he signs up and then we ask him to upload a photo or whatever and he uploads a photo of OneRepublic and then we like sync it back to the user profile, you know what I mean? I'm just trying to deal with like, I now have a user menu in the bottom corner and then I have like, you know, that's got his avatar and then I've got a creator avatar and I guess they're going to be the same avatar for now and then eventually we'll spin them into two avatars or something. I'm just like, is there precedent for like other people who have dealt with this kind of problem? I'm sure there are. And like, how would you handle going about like, do we treat them as two separate things with two separate settings in the back end and when you sign up, we automatically copy your user avatar over to your creator profile avatar and then you can then change it? Or like, I don't want to, I don't want empty states, so I don't really like the idea of having them create a profile and not, you know, like if they have a user avatar but they don't have a creator profile, like that's bad, you know what I mean? Like I'm just, what's the best way to deal with this?

---

## Assistant

Short version:  
Model **user** and **creator** avatars as *separate things in the data model*, but in the UX you:

- Ask for **one image** on signup.  
- Use it for **both** the user and the first creator.  
- In display logic, let **creator → user → default** act as the fallback chain.  
- Later, when multi-creator & teams exist, you just stop sharing by default and keep them independent.

I’ll break it down in a way that won’t paint you into a corner later.

---

## 1. Future-proof mental model

Think “Slack / Notion / Facebook Pages”:

- **User**  
  - `id`
  - `name`
  - `email`
  - `avatar_asset_id` (optional)
- **Creator** (the “link in bio” entity)  
  - `id`
  - `slug` / handle
  - `display_name`
  - `avatar_asset_id` (optional)
  - `owner_user_id` (for now; later remove this once you generalize)
- **Organization** (William Morris, label, agency, etc.)  
  - `id`
  - `name`
  - `avatar_asset_id` (optional)
- **Membership**  
  - `id`
  - `user_id`
  - `creator_id` or `org_id`
  - `role` (`owner`, `manager`, `editor`, etc.)
- **AvatarAsset** (S3 key, sizes, etc.)  
  - `id`
  - `url`
  - `type` (`user`, `creator`, `org`, whatever)

Even at MVP you can still *enforce*:
- 1 user ⇄ 1 creator  
…via constraints/logic, but structurally you’re already ready for “Ryan + OneRepublic + team + org.”

---

## 2. Avatar strategy: data vs UX

### Data-model rule (do this now)

- **User.avatar** and **Creator.avatar** are separate fields (each points to an `AvatarAsset`).
- You *never* rely on them being “the same thing”; you just occasionally set them to the same asset.

That gives you:

- Freedom later to have:
  - Ryan’s personal avatar on his account.
  - OneRepublic’s logo as the creator avatar.
- Simple overwrite rules (“don’t mess with my creator image if I change my login avatar”).

### Display rule (solves your “empty state” anxiety)

Anywhere you show a **creator avatar**:

```pseudo
displayCreatorAvatar = creator.avatar || user.avatar || defaultAvatar
```

Anywhere you show a **user/account avatar**:

```pseudo
displayUserAvatar = user.avatar || defaultAvatar
```

This way:
- If the creator has no avatar, you *still* show something (their user avatar).
- You don’t have to copy on write every time; the UI just knows how to fall back.

You can still *also* do a one-time copy at creation:

- When you create the creator and `creator.avatar` is null:
  - Set `creator.avatar = user.avatar`
- After that, **don’t auto-sync**. Let them diverge.

---

## 3. Signup flow at MVP (1 user ↔ 1 creator)

Goal: **One upload, zero confusion.**

Flow:

1. **Auth step**  
   - Email + password or social login.
2. **“Set up your Joby profile” screen**  
   - Ask: creator name, slug, etc.  
   - Ask once: “Profile image for your link in bio.”
3. Under the hood:
   - Create `User`
     - `user.avatar = uploaded_image` (or social’s avatar if they skip).
   - Create `Creator` for MVP:
     - `creator.owner_user_id = user.id`
     - `creator.avatar = user.avatar` (same asset)
4. **UI:**
   - Bottom-left account/menu uses the **creator avatar** (because they’re in “OneRepublic space”).
   - In account settings, they can later change:
     - “Account avatar” (user)
     - “Link in bio avatar” (creator)

You don’t have to mention “user vs creator” to them right now. UX story is simply:

> You signed up → we made your link in bio → this is its picture.

Technically you’ve populated both user and creator, but visually you only show the creator until you need user-level identity later.

---

## 4. The Ryan-creates-OneRepublic case

Scenario you’re worried about:

- Ryan signs up intending to create the **OneRepublic** link in bio, not “Ryan Tedder.”

Recommendations:

1. **Onboarding copy makes it clear this is for “your link in bio”**  
   - So the user naturally uploads the OneRepublic image.
2. Behind the scenes:
   - `user.avatar = OneRepublicImage`
   - `creator.avatar = OneRepublicImage`
3. Is it weird that his account avatar is OneRepublic for a while?  
   - Not really. For most of your early users, the account *is* the project/brand.
   - Later, when you introduce “personal account vs creators,” add:
     - A simple “Personalize your account” step where he can swap his account avatar if he cares.

If you want to be extra clean later:

- Add a small toggle in settings:
  - `[x] Use my account photo for this link in bio`
  - If they untick it, they upload a separate creator image.

---

## 5. Pre-created creators + claim links

You said: admins can create creators in the backend and send claim links.

Rules I’d use:

1. When admin creates a creator:
   - They can set a `creator.avatar` (logo, press shot, etc.).
2. When a user claims it:
   - If `creator.avatar` **already exists**, do **not** overwrite it.
   - If `creator.avatar` is **null**:
     - If `user.avatar` exists, set it as a one-time copy.
     - Otherwise leave null and rely on fallback logic (will show user avatar anyway once they set one).

This prevents:

- You uploading a carefully curated OneRepublic photo, then Ryan logs in with some random Google avatar and nukes it by accident.

---

## 6. How others handle this (precedent)

You’re basically recreating established patterns:

- **Facebook personal vs Pages / Business Manager**  
  - One login, many Pages. Each Page has its own avatar and name.
  - When you “act as” a Page, UI uses the Page avatar; the person’s real profile is mostly hidden.
- **Slack**  
  - One Slack account, many workspaces.
  - User has global identity, but per-workspace display details.
  - There is a “current context” (workspace) whose avatar & name dominate the UI.
- **Notion / Linear / Figma**  
  - One login, multiple workspaces/teams.
  - Context switcher + separate workspace vs account settings.

Your “creator” is effectively a **workspace / Page**, and your “user” is the person behind it.

So for Joby:

- The big avatar in the app chrome is the **current creator**.
- The account dropdown shows:
  - Current creator avatar & name.
  - Below that, “Account settings” with the user avatar, name, and email.

This is intuitive once you later let Ryan flip between “Ryan Tedder” and “OneRepublic.”

---

## 7. Migration path when you launch multi-creator & teams

If you follow the above from day one, the future steps are easy:

1. **Allow multiple creators per user**  
   - Add a “Create new link in bio” button.
   - New creator creation reuses the same rules:
     - If they upload an image during creation, use that for `creator.avatar`.
     - If they don’t, fall back to `user.avatar` in the UI.
2. **Add teams / organizations**  
   - Introduce `Organization` + `Membership` table.
   - Joining William Morris: new user account gets created, added to org, and by role gets access to all creators under that org.
   - Org avatar is yet another separate field; same fallback ideas apply.
3. **Backwards compatibility**  
   - Every existing user already has 1 creator with an avatar (copied or fallback).
   - No data migrations required beyond maybe renaming `owner_user_id` → membership entries.

---

## Concrete answer to your implied “how would you do it?”:

- **Yes**, treat user avatar and creator avatar as two distinct things in the backend.
- On signup, **don’t** ask twice. Ask once for the “link in bio” image and **set both** user and creator avatar to that asset.
- In the UI, wherever there’s a creator:
  - Show `creator.avatar || user.avatar || default`.
- Avoid auto-syncing after that. If they later change user avatar, do **not** silently overwrite creator avatars.
- For now, let the bottom corner avatar be the **creator** (current context). Personal account avatar only matters later in account settings / team contexts.

If you want, next step I can sketch the exact DB schema and a minimal React/API shape for the signup + claim flows so your devs can implement this without confusion.
