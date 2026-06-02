---
conversation_id: 69405272-2264-8330-9fa5-df29296b745a
created: 2025-12-15
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Spotify profile ownership API
type: note
updated: 2025-12-15
---

# Spotify profile ownership API

**Related:** [[jovie_music]]

> Conversation ID: 69405272-2264-8330-9fa5-df29296b745a
> Created: 2025-12-15T18:24:50Z
> Updated: 2025-12-15T18:25:33Z
> Messages: 2

---

## User

Is there a way for us to check if a spotify profile is actually owner or controlled by a user via api?

---

## Assistant

Mr. White — not directly.

Spotify’s Web API doesn’t have an endpoint that lets you ask “is this profile controlled by X?” for an arbitrary user. The only reliable way to verify control is to have the person **authenticate via Spotify OAuth** and then check which account the token belongs to.

How you do it in practice:

1. User clicks “Sign in with Spotify” (OAuth Authorization Code / PKCE). citeturn0search0turn0search13  
2. Your backend exchanges the code for an access token.
3. Call **GET `/v1/me`** (“Get Current User’s Profile”) with that token and read the returned **`id`**. citeturn0search1  
4. Compare that `id` to the profile you care about (e.g., the `user_id` in the profile URL, or by also calling **GET `/v1/users/{user_id}`** and comparing). citeturn0search2  

If `me.id === claimed_user_id`, you’ve effectively verified they control that Spotify account *to the same standard as “they can log in and grant access”*.

What **won’t** work: calling **GET `/v1/users/{user_id}`** alone only returns public profile info and does **not** prove control/ownership. citeturn0search2

If you tell me your stack (Node/Python/etc.), I can drop a minimal PKCE + `/me` verification snippet.


**Topic:** [[chatgpt-clusters/jovie_music]]
