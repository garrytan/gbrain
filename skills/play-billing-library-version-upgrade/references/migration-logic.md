## High-Impact Migration Logic

### 1. Connection Management (The v8+ Reconnection Shift)

**Intent**: Move from developer-managed state (manual retries) to
library-managed state.

- **Remove** : Manual `startConnection()` calls or retry timers inside `onServiceDisconnected()`.
- **Add** : `.enableAutoServiceReconnection()` to `BillingClient.Builder`.
- **Logic** : In v8+, the library handles transient disconnections. Your `onServiceDisconnected` must only be used for logging or updating UI state (e.g., "Billing service temporarily unavailable").

### 2. Product Querying \& Models (The v5-v8 Architectural Shift)

**Intent**: Support the "One Product, Multiple Offers" model introduced in v5
and refined in v8.

- **Data Model Swap** :
  - **Legacy** : `SkuDetails` (1:1 mapping of ID to price).
  - **Modern** : `ProductDetails`. A single `ProductDetails` can contain multiple `SubscriptionOfferDetails` (Base Plans + Offers).
- **Result Handling (v8+ Logic)** :
  - **Change** : `queryProductDetailsAsync` no longer returns a list in the listener.
  - **New Intent** : You must receive a `QueryProductDetailsResult` object.
  - **Refactor** : `kotlin
    // PBL 8+ Pattern
    billingClient.queryProductDetailsAsync(params) { result: QueryProductDetailsResult ->
    val responseCode = result.billingResult.responseCode
    val productDetailsList = result.productDetailsList // Retrieve list from result object
    // Process list...
    }`

### 3. Subscription Modernization (v6 \& v7)

**Intent**: Support "Base Plans" and "Offers" instead of legacy standalone SKUs.

- **Subscription Upgrades/Downgrades (v6+)**:

  - **Legacy** : `setOldSkuPurchaseToken()` in `BillingFlowParams`.
  - **Modern** : Use `SubscriptionUpdateParams`. You must specify the `PurchaseToken` of the existing subscription and the `ReplacementMode` (which replaces the deprecated `ProrationMode`).
  - **Logic** : Verify that the `ReplacementMode` matches the business intent (e.g., `CHARGE_FULL_PRICE` versus `WITH_TIME_PRORATION`).
- **Installment Plans (v7+)**:

  - **Intent**: Allow users to pay for a subscription in monthly installments.
  - **Check** : Look for `InstallmentPlanDetails` within `SubscriptionOfferDetails`. If the app supports high-ticket subscriptions, it is mandatory to implement the `installmentPlanDetails` UI.

### 4. Purchase Handling \& History (v6+)

**Intent**: Move away from local-only purchase caches to real-time status
checks.

- **Active Purchases** :
  - **Deprecated** : `queryPurchases()` (synchronous).
  - **Mandatory** : `queryPurchasesAsync()`. You must pass `QueryPurchasesParams` containing the `ProductType` (`INAPP` or `SUBS`).
- **Purchase History (Pagination Intent)** :
  - **v6+ Change** : `queryPurchaseHistoryAsync` is optimized for pagination.
  - **Logic** : If the app has thousands of historical transactions, verify you are using the `PurchaseHistoryRecord` list correctly to avoid memory overhead.

### 5. Security \& Pending Transactions (The "Always On" Rule)

- **Mandatory** : `enablePendingPurchases()` has been required since v3, but in v8+, verify that it is called before `.build()`. You must also include `.enableOneTimeProducts()` on the `enablePendingPurchases()` builder.
- **Optional** : If the app sells prepaid subscriptions, you must also include `.enablePrepaidPlans()`.
- **Intent**: This handles "Slow/Delayed" payments (like cash or bank transfers). Without this, the app will crash on initialization in modern versions.

### 6. SDK \& Environment Requirements

- **PBL 7.0** : Requires `compileSdk 34` or higher.
- **PBL 8.0** : Requires `compileSdk 34` or higher.
- **PBL 9.0** : Requires `compileSdk 35` or higher.
- **Kotlin** : Verify that `kotlin-stdlib` is updated to at least 1.9.x to support new library coroutine extensions.

### 7. User-Facing Features (Post-Upgrade Recommendations)

Once the upgrade is complete, the following features are enabled by these
versions:

- **v7** : **Installments** (Monthly payments for annual plans).
- **v8** : **Prepaid Plans** (Users can top-up time without auto-renewing).
- **v8** : **Personalized Pricing** (Show legal disclosure if price varies by user).
- **v9** : **In-App Price Reviews** (Users can accept upcoming subscription price increases directly inside the app without leaving for the Play Store; capped by Google at a maximum of once every 7 days).