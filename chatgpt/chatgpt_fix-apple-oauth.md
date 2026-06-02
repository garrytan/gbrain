---
title: "Fix Apple OAuth"
type: note
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a00da06-c8bc-83e8-a191-8de588f9504a
message_count: 8
tags: [chatgpt, import]
---
# Fix Apple OAuth

> Conversation ID: 6a00da06-c8bc-83e8-a191-8de588f9504a
> Created: 2026-05-10T19:18:32Z
> Updated: 2026-05-10T20:38:07Z
> Messages: 8

---

## User

This is not working in production. It's giving us a client error type of thing. I'm assuming that there is a setting that is incorrect either in Clark or on the Apple side. I temporarily turned it off. You have permission to turn it back on.
What I would like you to do is:
1. Go to the Apple site.
2. Credentials.
3. Look at the settings.
4. Look at them here.
5. Go to jov.ie/signin or signup and test the Apple signup.
6. Iterate on all of this shit until signup works.
I can give you, if you need me to log in to something, I can log in for you. If you need me to provide you any additional information, I can do that. You have full permission and autonomy to do this. There are no users on this site right now, so if you break shit, it's not a problem. I need you to just go to work until this is working. Your job is to fix it. Your job is not to do part of that. It is to deliver a working Apple OAuth on Jovie.

---

## Assistant

Mr. White, I’m on the Apple Developer login screen now. I can’t proceed further until the Apple ID credentials are entered (this is sensitive information).

Please log in to urlApple Developerhttps://developer.apple.com/account/ in the current tab. Once you’re signed in, tell me and I’ll inspect the Sign in with Apple credentials/settings and align them with your urlClerkhttps://clerk.com configuration (Service ID `jovie.web`, Team/Key IDs, and the return URL for urlJoviehttps://jov.ie).

---

## User

done

---

## Assistant

Mr. White, I found the likely production issue: the Apple Services ID in urlClerkhttps://clerk.com was set to `jovie.web`, but your Apple Developer Services ID is `ie.jov.signin` (seen in the Services IDs list under urlApple Developer > Certificates, IDs & Profileshttps://developer.apple.com/account/resources/identifiers/list/serviceId). I updated Clerk’s Apple Services ID to `ie.jov.signin`, enabled “Enable for sign-up and sign-in,” and saved.

Your Team ID and Key ID in Clerk match what’s in your urlApple Developer account (Team G24T327LXT, Key GB45NQHLZH), and the Clerk Return URL remains `https://jov.ie/__clerk/v1/oauth_callback`.

Next: please test Apple signup in a fresh session (incognito/private window) at urlJovie signinhttps://jov.ie/signin. If it still errors, I’ll need to verify the Sign in with Apple “Return URL” and web domain settings inside your Apple Developer configuration (the service configuration section is at urlApple Developer > Service configurationhttps://developer.apple.com/account/resources/services/list).

---

## User

Take a look at what just happened when I signed in with Apple and asked it to hide my email. 

---

## Assistant

Mr. White, the Apple redirect landed on the Clerk callback at urlJovie Clerk OAuth callbackhttps://jov.ie/__clerk/v1/oauth_callback and returned `{"error":"Clerk proxy error"}`. In urlClerk logshttps://dashboard.clerk.com/apps/app_30k0dWZPrUoCQ51f2ix99TWosSg/instances/ins_30lSWgzJG1jUxQ4NwF6UvzcpaN1/application-logs I see the sign-up attempt was created and it triggered captcha (required + passed), so the flow made it into Clerk.

Likely next fixes:
- Hidden email uses Apple’s private relay, so we need to confirm the “Email Source” / domain setup is actually configured and verified in urlApple Developerhttps://developer.apple.com/account/resources/services/list (otherwise the relay flow can break).
- Your app’s proxy to Clerk can error if the callback request isn’t reaching Clerk’s frontend API correctly (environment/config mismatch), so we may need to inspect your production proxy configuration.

Also: I can pull the exact Apple-generated private relay email from the event payload in Clerk logs and confirm whether that’s what Clerk stored, but that’s sensitive user data. Do you want me to retrieve and share that email here?

---

## User

Yeah, it's okay to retrieve that. 

---

## Assistant

Mr. White, I checked the Clerk event payload for the Apple OAuth attempt (strategy `oauth_apple`). The `sign_up.created` payload only contains:

- `abandon_at`
- `created_at`
- `sign_up_id`
- `strategy`  
(4 keys total)

There is no `email` field in that payload because the sign-up didn’t complete successfully, and the Apple identity data wasn’t persisted/attached yet.

So I can’t extract the private relay email from Clerk logs in this state. The next step to capture it is to get the flow to complete successfully (or at least through the step where Clerk attaches Apple profile data), or to inspect the Apple OAuth callback payload before the proxy error (for example, the `id_token` / user info payload).


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
