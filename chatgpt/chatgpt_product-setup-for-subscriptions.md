---
title: "Product Setup for Subscriptions"
type: guide
created: 2025-06-09
updated: 2025-06-09
source: chatgpt-export
conversation_id: 6847196d-c0f0-8007-b06a-6801c08d0609
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Product Setup for Subscriptions

> Conversation ID: 6847196d-c0f0-8007-b06a-6801c08d0609
> Created: 2025-06-09T17:27:09Z
> Updated: 2025-06-09T17:35:59Z
> Messages: 8

---

## User

We have to setup product offerings for our logyourbody app. It'll be 69.99 a year paid annual or monthly. well use revenue cat and stripe for web and apple payments for iOS.

Provide me the product names i should be setting in each. And everything i need to set including offerings and packages  and products

---

## Assistant

Mr. White, here’s a concise mapping of all the product & offering IDs you’ll need in App Store Connect, Stripe and RevenueCat:

---

**1. App Store Connect (iOS subscriptions)**  
- **Subscription Group ID**:  
  `com.logyourbody.premium.group`  
- **Products**:  
  - **Monthly**  
    - Product ID: `com.logyourbody.premium.monthly`  
    - Pricing: your chosen $ / mo  
  - **Annual**  
    - Product ID: `com.logyourbody.premium.annual`  
    - Pricing: $ 69.99 / yr  

---

**2. Stripe (web & non-iOS)**  
- **Product**:  
  - Name: “LogYourBody Premium”  
  - ID (auto-generated), but use this in your dashboard  
- **Prices**:  
  1. **Monthly**  
     - Price ID: `price_monthly_logyourbody`  
     - Recurring: monthly  
     - Unit amount: your $ / mo  
  2. **Annual**  
     - Price ID: `price_annual_logyourbody`  
     - Recurring: yearly  
     - Unit amount: 6999 (cents)  

---

**3. RevenueCat (single “premium” entitlement)**  
- **Entitlement ID**:  
  `premium_access`  
- **Offering ID**:  
  `main`  
- **Packages** inside that offering:  
  - **`monthly`** → links to both iOS and Stripe products:  
    - iOS: `com.logyourbody.premium.monthly`  
    - Stripe: `price_monthly_logyourbody`  
  - **`annual`** → links to:  
    - iOS: `com.logyourbody.premium.annual`  
    - Stripe: `price_annual_logyourbody`  

---

**4. Summary of IDs**  

| Platform        | ID                                     | Type        | Price          |
|-----------------|----------------------------------------|-------------|----------------|
| App Store       | com.logyourbody.premium.monthly        | product     | $ / mo         |
| App Store       | com.logyourbody.premium.annual         | product     | $ 69.99 / yr   |
| Stripe          | price_monthly_logyourbody              | price       | $ / mo         |
| Stripe          | price_annual_logyourbody               | price       | $ 69.99 / yr   |
| RevenueCat      | premium_access                         | entitlement | (none)         |
| RevenueCat      | main                                    | offering    | (contains both)|

---

**5. Next steps**  
- In App Store Connect: create your subscription group, then those two products.  
- In Stripe Dashboard: create “LogYourBody Premium” plus the two Prices.  
- In RevenueCat: define the `premium_access` entitlement, add an offering called `main`, then attach two packages (“monthly” & “annual”) pointing at the matching App Store and Stripe IDs.  

That’s all you need to wire up web (Stripe), iOS (App Store) and RevenueCat for your $ 69.99 / yr or monthly subscription.

---

## User

You get a 3 day trial. And there is no free plan.


---

## Assistant

Mr. White, here’s the updated mapping—with a 3-day free trial and no free tier:

---

**1. App Store Connect (iOS)**  
- **Subscription Group ID**  
  `com.logyourbody.premium.group`  
- **Products** (each with a 3-day free trial)  
  - **Monthly**  
    - Product ID: `com.logyourbody.premium.monthly`  
    - Duration: 1 month  
    - Price: your chosen $ / mo  
    - Free Trial: 3 days (set under “Subscription Prices” → “Free Trial Period”)  
  - **Annual**  
    - Product ID: `com.logyourbody.premium.annual`  
    - Duration: 1 year  
    - Price: $ 69.99 / yr  
    - Free Trial: 3 days  

---

**2. Stripe (web & non-iOS)**  
- **Product**  
  - Name: **LogYourBody Premium**  
  - ID: auto-generated (you’ll see it in your dashboard)  
- **Prices** (each with a 3-day trial)  
  1. **Monthly**  
     - Price ID: `price_monthly_logyourbody`  
     - Recurring: `month`  
     - Unit amount: your $ / mo (in cents)  
     - **Trial period**: 3 days (set “Trial period days” when creating the Price)  
  2. **Annual**  
     - Price ID: `price_annual_logyourbody`  
     - Recurring: `year`  
     - Unit amount: 6999 (cents)  
     - **Trial period**: 3 days  

---

**3. RevenueCat**  
- **Entitlement ID**: `premium_access`  
- **Offering ID**: `main`  
- **Packages** (both include a 3-day trial)  
  - **monthly**  
    - iOS Store Product: `com.logyourbody.premium.monthly`  
    - Stripe Price: `price_monthly_logyourbody`  
    - Trial days: 3  
  - **annual**  
    - iOS Store Product: `com.logyourbody.premium.annual`  
    - Stripe Price: `price_annual_logyourbody`  
    - Trial days: 3  

---

**4. Summary of IDs & Settings**

| Platform        | ID                                    | Type         | Price          | Trial |
|-----------------|---------------------------------------|--------------|----------------|-------|
| App Store       | com.logyourbody.premium.monthly       | Product      | $ / mo         | 3 d   |
| App Store       | com.logyourbody.premium.annual        | Product      | $ 69.99 / yr   | 3 d   |
| Stripe          | LogYourBody Premium                   | Product      | —              | —     |
| Stripe          | price_monthly_logyourbody             | Price        | $ / mo         | 3 d   |
| Stripe          | price_annual_logyourbody              | Price        | $ 69.99 / yr   | 3 d   |
| RevenueCat      | premium_access                        | Entitlement  | —              | —     |
| RevenueCat      | main                                  | Offering     | —              | —     |
| RevenueCat      | monthly, annual                       | Packages     | see above      | 3 d   |

---

**5. Next Steps**  
1. **App Store Connect**: create the group and both subscriptions, set each to 3-day trial.  
2. **Stripe Dashboard**: create “LogYourBody Premium” and two Prices; specify a 3-day trial on each.  
3. **RevenueCat**: define `premium_access`, create offering `main`, add “monthly” & “annual” packages with their store IDs and 3-day trials.  

That’s everything you need to wire up a 3-day trial, annual or monthly paid subscription—with no free plan.

---

## User

Can I set this up via cli?

---

## Assistant

Yes – you can script the entire setup end-to-end using CLI tools and APIs:

---

### 1. App Store Connect (iOS subscriptions)  
**Tool:** [AppStoreConnect CLI (`asc`)](https://github.com/ittybittyapps/appstoreconnect-cli)  
- **Install** (Homebrew):  
  ```bash
  brew tap ittybittyapps/appstoreconnect-cli  
  brew install --HEAD appstoreconnect-cli  
  ```  
- **Example** (create annual sub with 3-day trial):  
  ```bash
  asc in-app-purchase create subscription \
    --group-id com.logyourbody.premium.group \
    --product-id com.logyourbody.premium.annual \
    --reference-name "LogYourBody Premium Annual" \
    --subscription-duration P1Y \
    --price 69.99 \
    --locale en-US \
    --free-trial-duration P3D
  ```  
citeturn0search0turn0search4

---

### 2. Stripe (web & non-iOS)  
**Tool:** [Stripe CLI](https://docs.stripe.com/stripe-cli/overview)  
- **Install** (Homebrew):  
  ```bash
  brew install stripe/stripe-cli/stripe  
  ```  
- **Login**:  
  ```bash
  stripe login  
  ```  
- **Create product**:  
  ```bash
  stripe products create \
    --name "LogYourBody Premium"
  ```  
- **Create prices** (with 3-day trial):  
  ```bash
  stripe prices create \
    --unit-amount 6999 \
    --currency usd \
    --recurring interval=year \
    --product price_annual_logyourbody \
    --trial-period-days 3

  stripe prices create \
    --unit-amount    <MONTHLY_CENTS> \
    --currency       usd \
    --recurring      interval=month \
    --product        price_monthly_logyourbody \
    --trial-period-days 3
  ```  
citeturn0search3turn0search9

---

### 3. RevenueCat (cross-platform entitlement)  
**Tool:** RevenueCat REST API v2 (or community CLI)  
- **Official API**: hit the **Product Setup domain** endpoints to create your `premium_access` entitlement, `main` offering and attach your packages.  
  ```bash
  # create offering
  curl -X POST https://api.revenuecat.com/v1/offerings \
    -H "Authorization: Bearer $REVENUECAT_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"identifier":"main","description":"Default offering"}'

  # create package
  curl -X POST https://api.revenuecat.com/v1/offerings/main/packages \
    -H "Authorization: Bearer $REVENUECAT_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"identifier":"annual","description":"Annual plan","platformPrices":[{"store":"app_store","productId":"com.logyourbody.premium.annual"},{"store":"stripe","priceId":"price_annual_logyourbody"}],"introductions":[{"type":"free_trial","duration":{"unit":"DAY","value":3}}]}'
  ```  
- **Community CLI:**  
  Marcos Castany’s open-source CLI automates RevenueCat setup directly from your terminal. citeturn1search4

---

#### In practice  
1. **Export** your API keys / JWTs as env vars (`ASC_KEY`, `STRIPE_KEY`, `REVENUECAT_SECRET`).  
2. **Script** the commands above in a `setup.sh`.  
3. **Run** once to provision all products, prices, entitlements, offerings & packages across stores and RevenueCat.  

You’ll have zero-touch provisioning of your annual & monthly plans (with 3-day trials) via pure CLI.

---

## User

{
  "project_name": "LogYourBody",
  "app_name": "LogYourBody",
  "platforms": ["web"],
  "products": [
    {
      "identifier": "logyourbody_monthly",
      "type": "auto_renewable_subscription",
      "subscription_group": "logyourbody_subscriptions",
      "display_name": "LogYourBody Pro Monthly",
      "price": 9.99,
      "currency": "USD",
      "duration": "P1M"
    },
    {
      "identifier": "logyourbody_annual",
      "type": "auto_renewable_subscription", 
      "subscription_group": "logyourbody_subscriptions",
      "display_name": "LogYourBody Pro Annual",
      "price": 69.99,
      "currency": "USD",
      "duration": "P1Y"
    }
  ],
  "entitlements": [
    {
      "identifier": "pro_features",
      "display_name": "Pro Features",
      "products": ["logyourbody_monthly", "logyourbody_annual"]
    }
  ],
  "offerings": [
    {
      "identifier": "default",
      "display_name": "LogYourBody Pro",
      "packages": [
        {
          "identifier": "monthly",
          "product": "logyourbody_monthly",
          "display_name": "Monthly Plan"
        },
        {
          "identifier": "annual", 
          "product": "logyourbody_annual",
          "display_name": "Annual Plan"
        }
      ]
    }
  ]
}

How can i import this to revenue cat

---

## Assistant

RevenueCat doesn’t offer a one-click JSON import, but you can programmatically mirror your config via their new REST “Product Setup” API. The basic flow is:

1. **Create Entitlements**  
   - **Endpoint**: `POST /v1/entitlements`  
   - Body:  
     ```json
     { "identifier": "pro_features", "name": "Pro Features" }
     ```  
   - citeturn3search3

2. **Attach Products to Entitlements**  
   - **Endpoint**: `POST /v1/entitlements/{entitlement_id}/products`  
   - Body for each product:  
     ```json
     { "store": "stripe",     "productIdentifier": "logyourbody_monthly" }
     { "store": "stripe",     "productIdentifier": "logyourbody_annual"  }
     ```  
   - citeturn1search0

3. **Create Offerings**  
   - **Endpoint**: `POST /v1/offerings`  
   - Body:  
     ```json
     { "identifier": "default", "name": "LogYourBody Pro" }
     ```  
   - citeturn3search3

4. **Create Packages** under that offering  
   - **Endpoint**: `POST /v1/offerings/default/packages`  
   - Body for monthly:  
     ```json
     {
       "identifier": "monthly",
       "name": "Monthly Plan",
       "product": { "store": "stripe", "productIdentifier": "logyourbody_monthly" }
     }
     ```  
   - And similarly for annual. citeturn1search0

---

### Example Node.js Script

```js
import fs from 'fs'
import axios from 'axios'

const cfg = JSON.parse(fs.readFileSync('rc-config.json'))
const api = axios.create({
  baseURL: 'https://api.revenuecat.com/v1',
  headers: { Authorization: `Bearer ${process.env.REVENUECAT_SECRET}` }
})

async function setup() {
  // 1. Entitlements
  for (let e of cfg.entitlements) {
    await api.post('/entitlements', {
      identifier: e.identifier, name: e.display_name
    })
    for (let pid of e.products) {
      await api.post(`/entitlements/${e.identifier}/products`, {
        store: 'stripe', productIdentifier: pid
      })
    }
  }

  // 2. Offerings & Packages
  for (let o of cfg.offerings) {
    await api.post('/offerings', {
      identifier: o.identifier, name: o.display_name
    })
    for (let p of o.packages) {
      await api.post(`/offerings/${o.identifier}/packages`, {
        identifier: p.identifier, name: p.display_name,
        product: { store: 'stripe', productIdentifier: p.product }
      })
    }
  }
}

setup().catch(console.error)
```

1. Save your JSON as `rc-config.json`.  
2. Install dependencies: `npm i axios`.  
3. Set `REVENUECAT_SECRET` in your env.  
4. Run `node setup.js`.  

This will create your entitlement, offerings, and packages exactly as defined in your JSON.
