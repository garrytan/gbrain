---
title: "Vercel DNS Setup"
type: note
created: 2025-12-25
updated: 2025-12-25
source: chatgpt-export
conversation_id: 694d94d0-a044-8327-80b9-d2e148b47166
message_count: 2
tags: [chatgpt, import]
---
# Vercel DNS Setup

> Conversation ID: 694d94d0-a044-8327-80b9-d2e148b47166
> Created: 2025-12-25T19:47:34Z
> Updated: 2025-12-25T19:48:27Z
> Messages: 2

---

## User

make sure all these are set on this page:
Skip to content
Settings
Business
Account details
Account status
Business details
Linked external accounts
Customer emails
More
Default language


English
Payments
Successful payments

Refunds

To manage emails about invoices, failed payments, and more, visit Billing settings
Debit
Send Canada PAD mandate, debit initiation, and microdeposit verification emails
To customize these emails, view docs

Send BECS Australia mandate and debit initiation emails
To customize these emails, view docs

Send Bacs mandate and debit initiation emails
To customize these emails, view docs

Send NZ BECS Direct Debit mandate and debit initiation emails
Your current configuration requires these emails are enabled.

Send SEPA debit initiation emails
Your current configuration requires these emails are enabled.

Send ACH Direct Debit mandate and microdeposit verification emails
To customize these emails, view docs

Multibanco payments
Send payment instruction emails

Bank transfers
Send payment instruction emails

Pix payments
Send receipts for payments
This email is sent from our partner and includes details of additional taxes levied on buyers (e.g IOF), view docs

Send payment completion reminders

Support email
Email replies will go to dev@jov.ie based on your Public details settings
Your custom email domains
Add domain
Domain
Added
jov.ie
Verification failed
Dec 14, 12:01 AM
meetjovie.com
Verifying
Dec 25, 7:33 PM
stripe.com
​

Jovie
Search
Developers
Connect your domain
5 records have not been confirmed
If you just added these records, it can take up to 72 hours for your changes to take effect. If you continue having issues, review the instructions for your provider and make sure the DNS records are entered as shown.
Type
Name
Value
TXT
@ or leave it blank
stripe-verification=f05b563b4fe6967cbc0f970ace93a31f2366f6e11d5f1b32e9dc4e3963277be9
​
TXT
_dmarc
Your DMARC policy
CNAME
g6rhb6suyi4537pzj5myop6tcjoua7lu._domainkey
g6rhb6suyi4537pzj5myop6tcjoua7lu.dkim.custom-email-domain.stripe.com.
CNAME
3rja4m6xmymrqpyu3ka3moqjnbypuu3o._domainkey
3rja4m6xmymrqpyu3ka3moqjnbypuu3o.dkim.custom-email-domain.stripe.com.
​
CNAME
gpm6gmiirayjra5og3nsk3re4clpn4gj._domainkey
gpm6gmiirayjra5og3nsk3re4clpn4gj.dkim.custom-email-domain.stripe.com.
​
CNAME
nprdcrkblbiu7twtxjqzlu7moransb6o._domainkey
nprdcrkblbiu7twtxjqzlu7moransb6o.dkim.custom-email-domain.stripe.com.
CNAME
fawnuihancem4njo32yjrmz6mcofk2as._domainkey
fawnuihancem4njo32yjrmz6mcofk2as.dkim.custom-email-domain.stripe.com.
CNAME
jzn3oobkx2jqnwn6vcyk6uausfcu4nh6._domainkey
jzn3oobkx2jqnwn6vcyk6uausfcu4nh6.dkim.custom-email-domain.stripe.com.
CNAME
bounce
custom-email-domain.stripe.com.
​
Verification may take up to 72 hours while your record changes propagate—we'll email you afterward to finish setting up.
Close
Try verifying now

---

## Assistant

Mr. White — on your **Vercel DNS** page for **meetjovie.com**, you’re **almost** there. Here’s what to ensure matches what Stripe is asking for.

## Already set correctly (based on what’s visible)
- ✅ **TXT (apex / blank name)**: `stripe-verification=...` (you already have this)
- ✅ **CNAME DKIM**:  
  `3rja4m6...`, `gpm6gmi...`, `fawnui...`, `nprdcr...`, `jzn3oo...` → all present and pointing to `*.dkim.custom-email-domain.stripe.com.`
- ✅ **CNAME bounce**: `bounce → custom-email-domain.stripe.com.` (present)

## Missing / needs fixing
### 1) **DMARC record is not added yet (and you’re currently trying to add it as CNAME)**
You’re typing `_dmarc` but the **Type is set to CNAME**, which is why Vercel complains about “not a fully qualified domain name”.

Do this:
- **Name:** `_dmarc`
- **Type:** `TXT`
- **Value:** paste the **exact DMARC policy string** Stripe shows (it’s not included in what you pasted here—Stripe usually shows something like `v=DMARC1; p=...; ...`)
- **TTL:** leave blank (or default)

### 2) **Stripe says this DKIM record is required but it’s not in your current Vercel records**
Stripe lists:
- **CNAME** `g6rhb6suyi4537pzj5myop6tcjoua7lu._domainkey`
  → `g6rhb6suyi4537pzj5myop6tcjoua7lu.dkim.custom-email-domain.stripe.com.`

I do **not** see `g6rhb6...` in your “Current DNS Records” table. Add it:
- **Name:** `g6rhb6suyi4537pzj5myop6tcjoua7lu._domainkey`
- **Type:** `CNAME`
- **Value:** `g6rhb6suyi4537pzj5myop6tcjoua7lu.dkim.custom-email-domain.stripe.com.`
- **TTL:** leave blank (or 60)

## After adding those two
1) Wait a few minutes (sometimes propagation is fast on Vercel DNS).
2) Go back to Stripe and click **Try verifying now** again.

If you paste the **exact DMARC value Stripe shows** here, I’ll tell you precisely what to put in Vercel (and sanity-check formatting like quotes/semicolons).
