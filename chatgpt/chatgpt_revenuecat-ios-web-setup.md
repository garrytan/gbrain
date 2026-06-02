---
conversation_id: 68471614-d658-8007-886b-7367b0f20014
created: 2025-06-09
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: RevenueCat iOS Web Setup
type: note
updated: 2025-06-09
---

# RevenueCat iOS Web Setup

> Conversation ID: 68471614-d658-8007-886b-7367b0f20014
> Created: 2025-06-09T17:12:53Z
> Updated: 2025-06-09T17:13:56Z
> Messages: 2

---

## User

I wanna setup revenue cat with strip and apple payments for my cross platform app on iOS and web. What do i need to do. i already have the software end implemented

---

## Assistant

Mr. White, here’s a step‐by‐step on wiring up RevenueCat for both Apple in-app and Stripe web subscriptions:

**iOS (App Store)**  
- **Create subscriptions in App Store Connect**  
  My Apps → [Your App] → Features → Subscriptions → “+” → set up your Subscription Group and Products (use the same Product IDs in your code). citeturn0search1  
- **Add your app in RevenueCat & enter shared secret**  
  Dashboard → Project Settings → Apps → Add App Store App → paste your App-Specific Shared Secret (Account Settings → API Keys → App-Specific Shared Secret). citeturn0search11  
- **Configure App Store server notifications**  
  Still under that App’s settings, open Server Notifications → upload your App Store Connect API key (for real-time status updates). citeturn0search17  
- **Initialize in your code**  
  ```swift
  Purchases.configure(withAPIKey: "REVENUECAT_API_KEY")
  ```  
  Ensure your entitlement mapping matches your App Store Product IDs. citeturn0search15  

**Web (Stripe)**  
- **Connect Stripe to RevenueCat**  
  Dashboard → Integrations → Stripe Billing → “Connect Stripe” → complete the OAuth flow. citeturn0search2  
- **Define Products & Prices in Stripe**  
  In Stripe Dashboard → Products → New Product → set up each subscription plan → note the Price ID for each. citeturn0search6  
- **Link Stripe Prices in RevenueCat**  
  Dashboard → Project Settings → Apps → [Your Web App] → Stripe Products → Add each Stripe Price ID and map to your entitlements. citeturn0search6  
- **Set up Stripe webhooks**  
  1. Copy RevenueCat’s Webhook URL (Project Settings → Apps → Webhook Configuration).  
  2. In Stripe Dashboard → Webhooks → Add endpoint → paste URL → subscribe to `checkout.session.completed`, `invoice.payment_succeeded`, `customer.subscription.*`.  
  3. Copy the Signing Secret and paste it back in RevenueCat. citeturn0search14  
- **Install & use the Web SDK**  
  ```bash
  npm install @revenuecat/purchases-web
  ```  
  ```js
  import { Purchases } from '@revenuecat/purchases-web';
  Purchases.setup("REVENUECAT_PUBLIC_API_KEY");
  const offerings = await Purchases.getOfferings();
  await Purchases.purchasePackage(offerings.current.availablePackages[0]);
  ```  
  This handles Stripe Checkout flow and unlocks entitlements. citeturn0search4  
- **(Optional) Apple Pay on the web**  
  In Stripe Dashboard → Payment Methods → Apple Pay → register your domain and host the verification file as instructed. citeturn0search5  

**Testing**  
- Use App Store Connect sandbox users + RevenueCat’s sandbox mode to validate iOS flows.  
- In Stripe test mode, simulate Checkouts + webhook events to confirm entitlements unlock on both platforms.  



**Topic:** [[chatgpt-clusters/coding_mobile]]
