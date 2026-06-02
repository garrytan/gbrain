---
conversation_id: 694081b0-5be0-8325-9578-1534bcc117be
created: 2025-12-15
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Spotify artist detection methods
type: note
updated: 2025-12-15
---

# Spotify artist detection methods

**Related:** [[jovie_music]]

> Conversation ID: 694081b0-5be0-8325-9578-1534bcc117be
> Created: 2025-12-15T21:46:24Z
> Updated: 2025-12-15T21:50:04Z
> Messages: 2

---

## User

if we use sign in with spotify as a login option in our app can we tell if that user has an artist attatched to it?

---

## Assistant

Yes, **but only indirectly**, Mr. White.

**Spotify does NOT expose a simple flag like `is_artist = true`.**  
Using *Sign in with Spotify* (OAuth), you can infer it **only if the user authorizes specific scopes**.

### What Spotify Gives You by Default
With basic login scopes:
- User ID
- Email
- Country
- Account type (free/premium)
❌ **No indication of artist ownership**

### How You Can Detect an Attached Artist
You must request **artist-related scopes** and then query artist endpoints.

**Required scope**
```
user-read-private
```
(Plus artist-specific endpoints depending on method below.)

#### Method 1: Check “Current User’s Artists”
Call:
```
GET https://api.spotify.com/v1/me/following?type=artist
```
If the user follows **their own artist profile**, you *can infer* ownership — **but this is not guaranteed**.

#### Method 2 (Most Reliable): Spotify for Artists Access
Spotify **separates artist admin status** from consumer accounts.

To definitively know:
- User must authenticate **via Spotify for Artists**
- You must be approved for **Spotify for Artists API**
- Endpoint returns:
  - Artist IDs the user manages
  - Role (admin/editor)

This is the **only authoritative method**.

### Hard Truth (Important)
- A normal Spotify user account **cannot prove artist ownership**
- Spotify intentionally restricts this for security/business reasons
- Any consumer-login-only solution is **heuristic, not guaranteed**

### Practical Recommendation
If your app depends on artist verification:
1. Use **Sign in with Spotify** for general users
2. Add **“Connect Spotify for Artists”** as a second, explicit step
3. Gate artist features behind that connection

If you want, I can outline:
- Required OAuth scopes
- Exact API calls
- UX flow that Spotify typically approves
- Common rejection reasons from Spotify review  

Just say the word.


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_download-spotify-artist-images]]
- [[chatgpt/chatgpt_ai-driven-artist-profiles]]
- [[chatgpt/chatgpt_artist-api-search-issue]]
- [[chatgpt/chatgpt_artist-data-via-api]]
- [[chatgpt/chatgpt_artist-dj-relations-jobs]]
