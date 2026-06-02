---
title: "Spotify OAuth Guide"
type: note
created: 2026-01-04
updated: 2026-01-04
source: chatgpt-export
conversation_id: 695ad74a-5fec-832a-82c7-58fadfbfb098
message_count: 2
tags: [chatgpt, import, code]
---
# Spotify OAuth Guide

> Conversation ID: 695ad74a-5fec-832a-82c7-58fadfbfb098
> Created: 2026-01-04T21:10:34Z
> Updated: 2026-01-04T21:11:13Z
> Messages: 2

---

## User

spotify oauth

---

## Assistant

Here’s a concise guide to **Spotify OAuth (OAuth 2.0)** and how to implement it so your app can access Spotify APIs securely.

## 🔑 Basics

Spotify uses **OAuth 2.0** for authentication/authorization. Your app needs an **access token** to call Spotify Web API endpoints. All requests require this token in the HTTP `Authorization` header:  
```
Authorization: Bearer <access_token>
``` citeturn0search8

## 📌 OAuth Flows Spotify Supports

Spotify supports several OAuth flows depending on your app type: citeturn0search0

1. **Authorization Code Flow** – for server-side apps (can store client secret). Provides refresh tokens.  
2. **Authorization Code with PKCE** – for SPAs/mobile apps (no secret stored, more secure).  
3. **Client Credentials Flow** – for backend APIs that **don’t access user data**.

## 🧠 When to Pick Which

| Flow | Needs User Login | Client Secret | Refresh Token |
|------|-----------------|----------------|----------------|
| Authorization Code | ✅ | ✅ | ✅ |
| Authorization Code w/ PKCE | ✅ | ❌ | ✅ |
| Client Credentials | ❌ | ✅ | ❌ | citeturn0search0

## 🛠️ Authorization Code Flow (Typical Web App)

### 1) Register Your App
- Create an app at Spotify Developer Dashboard → get **Client ID** & **Client Secret**.  
- Add a **Redirect URI** where Spotify will send users after login. citeturn0search1

### 2) Redirect User to Spotify for Login
Send the user to:
```
https://accounts.spotify.com/authorize?
 client_id=YOUR_CLIENT_ID
 &response_type=code
 &redirect_uri=YOUR_REDIRECT_URI
 &scope=desired_scopes
 &state=optional_random
```
*(scopes control what permissions you request)* citeturn0search6

### 3) Receive Authorization Code
Spotify redirects back to:
```
YOUR_REDIRECT_URI?code=AUTH_CODE
```
You'll get a `code` query param. citeturn0search6

### 4) Exchange Code for Tokens
POST to:
```
https://accounts.spotify.com/api/token
```
with body:
```
grant_type=authorization_code
code=AUTH_CODE
redirect_uri=YOUR_REDIRECT_URI
```
Headers:
```
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded
```
Response gives:
- `access_token` (use in API calls)  
- `refresh_token` (to get new access tokens) citeturn0search2

## 🧠 Authorization Code with PKCE (Browser/Mobile Safe)

PKCE lets you avoid using a client secret in public clients. Steps are similar to authorization code but include generating a **code challenge/verifier** before redirecting users. citeturn0search22

## 🧑‍💻 Client Credentials Flow (No User)

For backend jobs that don’t need user data:

```
POST https://accounts.spotify.com/api/token
Headers:
  Authorization: Basic base64(client_id:client_secret)
Body:
  grant_type=client_credentials
```
You get an `access_token` only. No refresh token. citeturn0search5

## 🎯 Making API Calls

Once you have an access token, call Spotify APIs like:

```
GET https://api.spotify.com/v1/me/playlists
Headers:
  Authorization: Bearer ACCESS_TOKEN
```
This returns JSON. citeturn0search8

## 🔁 Token Refresh

Access tokens expire. Use the **refresh_token** (from auth code flows) to get new access tokens without prompting the user again. citeturn0search2

---

If you want, I can provide **sample code snippets** (Node.js, Python, or other) for one of these flows. Just tell me your stack.
