---
title: "Clerk Apple Sign-In Issue"
type: essay
created: 2025-07-06
updated: 2025-07-06
source: chatgpt-export
topic: coding-mobile
message_count: 14
tags: [chatgpt, knowledge, coding-mobile]
---
# Clerk Apple Sign-In Issue

> **Source:** ChatGPT conversation
> **Date:** 2025-07-06T20:31:50Z
> **Messages:** 14
> **Topic:** coding-mobile

## Question

I'm having a lot of problems getting Clerk working. I have, well, with the Swift iOS app, I have Clerk off working with email, but I'm having a lot of problems getting it working with Sign-In with Apple. Currently, I hit the Sign-In with Apple button, and I get the native Sign-In with Apple pop-up. It shows my account. It shows the app logo. I click on it. I get the green light. I get the check mark and everything, and then it comes up and says, Authentication error. Apple Sign-In is not properly configured. Please try Sign-In with email instead. I have thoroughly gone through and checked to make sure that all of the credentials for the Apple Sign-In settings are correct in the OAuth settings on the Clerk dashboard, and we are using a production instance. I can't seem to figure out why it's not working, and I've gone through and redone this multiple times. I've made sure that the return URL is correct on the Apple Dev dashboard. I've made sure that the domains are clear. I don't know w

## Answer

Got it. When Clerk's Apple Sign-In gives that error *after* showing a successful native Apple UI, it's usually one of these issues—**even if** everything looks right on Clerk and Apple Developer:

---

### ✅ **Checklist to Debug “Apple Sign-In is not properly configured”**

---

#### 🔐 1. **Apple Services ID mismatch**
- In Apple Dev Console (`Identifiers > Services IDs`), the **Services ID (Client ID)** must match **exactly** what you put in Clerk’s Apple settings.
- **Common issue:** Clerk shows a default like `clerk.{your-app-name}`, but you used a different custom Services ID (or vice versa).

---

#### 🌐 2. **Redirect URI must match exactly**
- Example: `https://clerk.{your-domain}.com/v1/callback/apple`
- This must be:
  - Whitelisted in Apple Developer Console.
  - Entered *exactly* in Clerk’s settings.
  - If you’re using a **custom domain**, make sure **Apple is set up to trust that domain** and it’s been verified.

---

#### 👥 3. **User Info Scope Not Requested**
- When calling the native Apple Sign-In flow, **you must request `email` and `fullName`** or Clerk can’t register the user.
- Sample Swift config:
```swift
let request = ASAuthorizationAppleIDProvider().createRequest()
request.requestedScopes = [.fullName, .email]
```

---

#### 🔐 4. **Incorrect `nonce` or missing `idToken`**
- Clerk requires a **valid, verifiable `idToken`** back from Apple.
- You must send the `idToken` (and optionally the `nonce`) to Clerk using their API endpoint.
- This is what’s failing if the Apple popup completes but Clerk says “not properly configured.”

In Swift, after you get the credential:
```swift
guard let appleIDCredential = authResult.credential as? ASAuthorizationAppleIDCredential,
      let identityToken = appleIDCredential.identityToken,
      let idTokenString = String(data: identityToken, encoding: .utf8) else {
    // handle error
    return
}

Clerk.client.signInWithApple(idToken: idTokenString) { result in
    // handle result
}
```

If you’re using the [Clerk iOS SDK](https://clerk.dev/docs/reference/ios/clerk-class-reference), they handle some of this, but if you're doing a custom integration, this is critical.

---

#### 🧪 5. **Try it with the Clerk test domain**
- Temporarily switch back to using your app on `clerk.accounts.dev` instead of your custom domain.
- If it works there, the issue is 100% with Apple domain verification or redirect URI mismatch.

---

If you want, send me:
1. Your Clerk domain (`your-app.clerk.accounts.dev` or custom).
2. The exact redirect URI used.
3. Whether you're using the Clerk iOS SDK or doing a custom Apple Sign-In handler.

I’ll help you pinpoint it.

## Question

{'asset_pointer': 'file-service://file-FEDDRFD4tvvSLSCmJfKYSo', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 785, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 350101, 'width': 582}
How do these look

## Answer

Thanks, Mr. White. Based on that screenshot, here’s a breakdown of what looks **correct** vs what needs **double-checking**:

---

### ✅ Looks Good
- **Apple Services ID**: `com.auth.logyourbody` — consistent format.
- **Team ID / Key ID / Private Key**: All seem well-formed and correctly included.
- **Return URL**: `https://clerk.logyourbody.com/v1/oauth_callback/apple` — format is valid.
- **Private Relay Email**: Optional, but harmless.

---

### 🔍 What to Double-Check or Fix

#### 1. **Services ID in Apple Developer must match**  
Go to **Apple Developer → Identifiers → Services IDs**  
- You must have a **Services ID** named exactly `com.auth.logyourbody`.
- It must have:
  - **Sign in with Apple** enabled
  - **Web domain** = `logyourbody.com`
  - **Return URL** = `https://clerk.logyourbody.com/v1/oauth_callback/apple` — **must match exactly**

---

#### 2. **Domain Verification**
- In Apple Developer → More → Sign in with Apple → Your App → **Web Domain Verification**
- Ensure `clerk.logyourbody.com` has passed verification.
  - If you’re using a Clerk-hosted subdomain and CNAME-ing a custom domain, **you must still complete domain verification on Apple’s side** by uploading the `.well-known/apple-developer-domain-association` file or confirming it via Clerk.

---

#### 3. **Ensure `id_token` is being passed to Clerk from the iOS app**
After Apple’s native auth completes:
```swift
let credential = authResult.credential as! ASAuthorizationAppleIDCredential
let idToken = credential.identityToken
let tokenString = String(data: idToken!, encoding: .utf8)
```
Then use Clerk’s iOS SDK to pass it:
```swift
Clerk.client.signInWithApple(idToken: tokenString!) { result in
    // Handle auth or error
}
```
If this step fails or is skipped, Clerk throws the vague “Sign-In not configured properly” message.

---

### Final Suggestion

If all the above is confirmed and it’s still failing:
- **Temporarily switch to `clerk.accounts.dev` domain** in the Clerk dashboard and try again.
- If that works, the issue is 100% in Apple domain verification or return URL mismatches for the custom domain.

Want me to walk you through your Apple Dev Console setup to double-check it all?

## Question

I can't find the Apple Developer Web Domain Verification menu.

## Answer

Apple hides it a bit. Here’s exactly how to get to the **Web domain verification for Sign in with Apple**:

---

### ✅ Steps to Find Web Domain Verification in Apple Developer

1. Go to [Apple Developer](https://developer.apple.com/account/resources/identifiers/list/serviceId)
2. Click your **Services ID** (e.g. `com.auth.logyourbody`)
3. Under **"Sign In with Apple"**, click **Configure**
4. Scroll to **Web** section
5. Under **Domains and Subdomains**, add:  
   ```
   clerk.logyourbody.com
   ```
6. Under **Return URLs**, add:  
   ```
   https://clerk.logyourbody.com/v1/oauth_callback/apple
   ```
7. Click **Save**

---

### 🔐 Then Verify the Domain

Apple will ask you to upload a file to:
```
https://clerk.logyourbody.com/.well-known/apple-developer-domain-association
```

Clerk can host this file automatically **if you're using their custom domain support**. Go to:

> Clerk Dashboard → Custom Domains → Select your domain → Check domain verification status

If you haven't verified it yet:
- Follow Clerk’s instructions to verify via Apple
- Once that domain is verified with Apple, Sign-In with Apple will work properly

---

Let me know if you want help checking the Apple file yourself or if Clerk is hosting it for you.

## Question

{'asset_pointer': 'file-service://file-8iNvDAf1VDRohUVXJqegiX', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 629, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 179970, 'width': 734}

## Answer

Thanks, Mr. White. That screen confirms you're in the right place, and your configuration looks almost perfect.

Here’s what I see and what to verify:

---

### ✅ Confirmed Working:
- `clerk.logyourbody.com` is listed ✅  
- Return URL `https://clerk.logyourbody.com/v1/oauth_callback` is correct ✅  
- Primary App ID is linked ✅

---

### 🔍 One Critical Thing Left:
Check if the little blue icon next to `clerk.logyourbody.com` has a **checkmark** ✅ or a **warning symbol** ⚠️.

If it's **not verified**, that’s your issue.

---

### 🔧 To Fix That:

1. In **Clerk Dashboard → Custom Domains → clerk.logyourbody.com**, make sure domain verification is **complete**.
2. Clerk automatically hosts the `.well-known/apple-developer-domain-association` file **if**:
   - You're using their custom domain system (not a manual reverse proxy).
   - You've added the domain in Clerk and clicked "verify with Apple."
3. Then go back to the Apple Developer screen and:
   - Click **Continue**
   - Then **Save**

---

### ✅ Final Check

After you’ve done this:
- Try Sign-In with Apple again.
- If it still fails: log the response from `ASAuthorizationAppleIDCredential` and ensure you’re sending the **`identityToken`** to Clerk.

If you want to paste that token (or log) here, I’ll check it.

## Question

{'asset_pointer': 'file-service://file-Mk3dpybH5xqhKMHPQmURrq', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 630, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 210810, 'width': 1303}
I see no option to verify it. I just see those empty blue boxes. If I go to this other page, I see this related to emails.

## Answer

Thanks. You're looking at two **different things**:

---

### 🧾 What You're Seeing Now (Email Sources)
That screen with SPF status is just for Apple’s **private email relay system**. It has nothing to do with your Sign in with Apple domain verification. You can ignore this for now.

---

### 🔎 What Matters: Domain Verification for `clerk.logyourbody.com`
The **missing piece** is: Apple hasn’t verified your custom domain yet for OAuth.

---

### ✅ How to Verify Your Domain for Apple Sign-In

1. **Go to Clerk Dashboard → Custom Domains**
   - Make sure `clerk.logyourbody.com` is added.
   - There should be a **"Verify with Apple"** button or similar under Apple OAuth settings.

2. If Clerk doesn't show that:
   - Go to: [Apple Developer → Certificates, Identifiers & Profiles → More → Sign in with Apple](https://developer.apple.com/account/resources/services/list)
   - Select your **Service ID** → Configure
   - Under the Website URLs section, **click the blue icon** next to `clerk.logyourbody.com` (the one without a checkmark)
   - Apple should prompt you to upload a file to:  
     ```
     https://clerk.logyourbody.com/.well-known/apple-developer-domain-association
     ```

3. In **Clerk**, under Custom Domains → `clerk.logyourbody.com`, there should be a **hosted file preview** confirming that Clerk is serving the verification file.  
   - If not, you’ll need to **manually download and upload** that file via your DNS provider or server (unlikely with Clerk-managed custom domain).

---

### ✅ You’re Almost There
Your SPF/email config is perfect. But until Apple sees `clerk.logyourbody.com` as a **verified domain** (with a checkmark next to it), Sign-In with Apple will fail **even if the rest is flawless**.

Want to send me the Clerk domain dashboard screenshot or let me guide you to the exact file URL to check?

## Question

{'asset_pointer': 'file-service://file-4Q7vdd16uCBJmUE2vsMQ7T', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 475, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 213208, 'width': 1051}
{'asset_pointer': 'file-service://file-GZkShcsSYzAbTxudH6WVsM', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 738, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': Tru

## Answer

Thanks, Mr. White — that confirms it.

### ✅ What’s Working
- DNS and SSL are 100% verified ✅
- `clerk.logyourbody.com` is correctly CNAME’d and green across the board ✅
- This rules out all frontend misconfig, DNS issues, or SSL blocks ✅

---

### ❌ What’s Still Missing

You **still haven’t verified your domain with Apple** for use with Sign In with Apple.

Clerk manages DNS and SSL, but **you still have to let Apple know that `clerk.logyourbody.com` is trusted** by uploading (or auto-hosting) the file Apple checks.

---

### 🔧 How to Trigger Apple’s Verification (Final Step)

Go to:

1. **Clerk Dashboard → Auth → Social Connections → Apple**
2. Scroll down to where you entered:
   - Services ID: `com.auth.logyourbody`
   - Return URL: `https://clerk.logyourbody.com/v1/oauth_callback/apple`
3. Somewhere near the Return URL field, **you should see a button or banner saying something like**:
   - “Verify domain with Apple”
   - or “Download verification file”
   - or “This domain has not been verified by Apple”

If you don't see it:

- Try changing the Return URL to anything else (e.g. add `?verify=1`) and hit "Update"
- Then switch it back and hit "Update" again — this can sometimes retrigger the Apple verification UI in Clerk

---

### 🔍 Manually Confirm Domain Verification File
Try visiting this URL in your browser:
```
https://clerk.logyourbody.com/.well-known/apple-developer-domain-association
```
- If you see a JSON file download, you’re good.
- If you see a 404 — this is your problem. Apple can’t verify the domain, so Sign In fails.

---

Once Apple verifies the domain, the blue box next to `clerk.logyourbody.com` on the Apple Developer dashboard will turn into a ✅.

Then Sign-In with Apple will work.

Let me know if you want to test the auth response in Swift next to verify `identityToken` flow.

## Question

{'asset_pointer': 'file-service://file-SWAqYuzpg7gjV6rqXBtDcv', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 746, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 355286, 'width': 544}
{'asset_pointer': 'file-service://file-12m3pxo3Hy4WiLPDZ87mc7', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 475, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True

## Answer

Thanks, Mr. White. You’re clearly deep in the trenches on this — here's the most concise and targeted answer possible now that we’ve ruled out everything else:

---

### ❌ You Are Missing Apple Domain Verification

Even though Clerk config is ✅, you are still missing this:

#### ‼️ The file at:
```
https://clerk.logyourbody.com/.well-known/apple-developer-domain-association
```
does **not** exist or is **not accessible to Apple**.

That’s why Apple Sign-In fails **after** the green check — because Clerk tries to verify `clerk.logyourbody.com` with Apple, and Apple says “nope.”

---

### ✅ How to Fix It in 2 Steps

1. **Manually download your Apple domain association file**
   - Go to Apple Developer → More → Sign In with Apple → Your Service ID → Configure
   - Scroll down and add `clerk.logyourbody.com` if it’s not there already.
   - Apple should show you a file like this:
     ```
     apple-developer-domain-association
     ```
   - Download it.

2. **Upload it manually to Clerk**
   - Open a support chat or file a ticket with Clerk.
   - Tell them:
     > “I need the file `apple-developer-domain-association` hosted at `.well-known` on my custom domain: `clerk.logyourbody.com`. Apple won’t complete OAuth without it.”

---

### 🔁 OR: Use the Default Clerk Domain

If you're stuck and want to test functionality now:
- In Clerk, switch your OAuth Return URL to:
  ```
  https://clerk.{your-clerk-subdomain}.accounts.dev/v1/oauth_callback/apple
  ```
- And switch `com.auth.logyourbody` to `clerk.{your-clerk-subdomain}` in the Apple Service ID.

That will work instantly, because Clerk has already verified their own `.accounts.dev` domain with Apple.

---

Let me know if you want me to walk you through Apple’s file download or help draft the Clerk support request. You're 1 file away from this working.
