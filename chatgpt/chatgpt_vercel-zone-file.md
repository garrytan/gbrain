---
title: "Vercel Zone File"
type: guide
created: 2025-12-25
updated: 2025-12-25
source: chatgpt-export
conversation_id: 694d9276-da4c-832c-86ae-0a40ed259724
message_count: 4
tags: [chatgpt, import, code]
---
# Vercel Zone File

> Conversation ID: 694d9276-da4c-832c-86ae-0a40ed259724
> Created: 2025-12-25T19:37:37Z
> Updated: 2025-12-25T19:44:53Z
> Messages: 4

---

## User

Generate a zone file I can add to vercel
Skip to content
Settings
Business
Account details
Account status
Business details
Linked external accounts
Bank accounts and currencies
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
Navigated to Customer emails – Jovie – Stripe

Jovie
Home
Balances
Transactions
Customers
Product catalog
Shortcuts
Atlas
Billing overview
Workflows
Identity
Products
Payments
Billing
Reporting
More
Search
Developers
Connect your domain
Add these DNS records to your domain provider or edit your existing DNS records to verify that you own this domain. Find directions for your provider
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
​
CNAME
g6rhb6suyi4537pzj5myop6tcjoua7lu._domainkey
g6rhb6suyi4537pzj5myop6tcjoua7lu.dkim.custom-email-domain.stripe.com.
​
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
​
CNAME
fawnuihancem4njo32yjrmz6mcofk2as._domainkey
fawnuihancem4njo32yjrmz6mcofk2as.dkim.custom-email-domain.stripe.com.
​
CNAME
jzn3oobkx2jqnwn6vcyk6uausfcu4nh6._domainkey
jzn3oobkx2jqnwn6vcyk6uausfcu4nh6.dkim.custom-email-domain.stripe.com.
​
CNAME
bounce
custom-email-domain.stripe.com.
​
Verification may take up to 72 hours while your record changes propagate—we'll email you afterward to finish setting up.
Close
Try verifying now


---

## Assistant

Mr. White, here’s a BIND-style zone file you can paste into **Vercel → Domains → (your domain) → DNS → Import Zone File**. I assumed the domain is **meetjovie.com** (change `$ORIGIN` if you’re verifying `jov.ie` instead).

```zone
$TTL 3600
$ORIGIN meetjovie.com.

; Stripe domain verification
@                       IN  TXT   "stripe-verification=f05b563b4fe6967cbc0f970ace93a31f2366f6e11d5f1b32e9dc4e3963277be9"

; DMARC (safe starter policy — replace with your preferred policy if you already have one)
_dmarc                  IN  TXT   "v=DMARC1; p=none; adkim=s; aspf=s; fo=1"

; Stripe DKIM (CNAME)
g6rhb6suyi4537pzj5myop6tcjoua7lu._domainkey  IN  CNAME  g6rhb6suyi4537pzj5myop6tcjoua7lu.dkim.custom-email-domain.stripe.com.
3rja4m6xmymrqpyu3ka3moqjnbypuu3o._domainkey  IN  CNAME  3rja4m6xmymrqpyu3ka3moqjnbypuu3o.dkim.custom-email-domain.stripe.com.
gpm6gmiirayjra5og3nsk3re4clpn4gj._domainkey  IN  CNAME  gpm6gmiirayjra5og3nsk3re4clpn4gj.dkim.custom-email-domain.stripe.com.
nprdcrkblbiu7twtxjqzlu7moransb6o._domainkey  IN  CNAME  nprdcrkblbiu7twtxjqzlu7moransb6o.dkim.custom-email-domain.stripe.com.
fawnuihancem4njo32yjrmz6mcofk2as._domainkey  IN  CNAME  fawnuihancem4njo32yjrmz6mcofk2as.dkim.custom-email-domain.stripe.com.
jzn3oobkx2jqnwn6vcyk6uausfcu4nh6._domainkey  IN  CNAME  jzn3oobkx2jqnwn6vcyk6uausfcu4nh6.dkim.custom-email-domain.stripe.com.

; Bounce handling
bounce                  IN  CNAME  custom-email-domain.stripe.com.
```

If you meant **jov.ie**, just change the first line to:
```zone
$ORIGIN jov.ie.
```

---

## User

Make us a smart policy. meetjovie.com is the domain. We send from gmail and stripe

---

## Assistant

Mr. White, here’s a **“smart” (enforcing but low-risk) email auth policy** for **meetjovie.com** when you send via **Google (Gmail/Workspace)** and **Stripe**.

Paste/import this into Vercel DNS (zone file style):

```zone
$TTL 3600
$ORIGIN meetjovie.com.

; --- SPF (Google Workspace / Gmail) ---
@  IN  TXT  "v=spf1 include:_spf.google.com ~all"

; --- DMARC (start enforcing gently, with reporting) ---
; IMPORTANT: make sure dmarc@meetjovie.com exists (or change rua= to an address you control).
_dmarc  IN  TXT  "v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@meetjovie.com; adkim=s; aspf=r; fo=1; sp=quarantine; ri=86400"
```

Why this works with your setup:
- Google’s recommended SPF pattern is `include:_spf.google.com`. citeturn1search5  
- Stripe custom email domains authenticate primarily via the DKIM CNAMEs Stripe gives you (which you already added). citeturn0search0turn0search16  
- DMARC supports `p=none|quarantine|reject`, and `pct=` lets you roll out enforcement safely. citeturn1search1turn1search10  

If you want the **“final” hardened policy** after you confirm legit mail is passing, change DMARC to:
```zone
_dmarc IN TXT "v=DMARC1; p=reject; pct=100; rua=mailto:dmarc@meetjovie.com; adkim=s; aspf=r; fo=1; sp=reject; ri=86400"
```
