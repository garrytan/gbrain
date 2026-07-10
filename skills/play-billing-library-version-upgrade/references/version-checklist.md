## Play Billing Library: Smart Version-Specific Checklist

Use this checklist to verify that every technical requirement between your
\[Current Version\] and \[Target Version\] has been met.

## PBL v1.x through v3.x

- \[ \] **\[v1.0\] Builder Pattern** : Verify `BillingClient.newBuilder(context)` is used.
- \[ \] **\[v2.0\] Mandatory Acknowledgment** : Verify `acknowledgePurchase()` or `consumeAsync()` is called within 3 days.
- \[ \] **\[v2.0\] Response Types** : Logic must handle `BillingResult` objects instead of raw integers.
- \[ \] **\[v3.0\] Legacy Removal** : Verify `ChildDirected` and `UnderAgeOfConsent` parameters are deleted.

## PBL v4.x Series

- \[ \] **Async Purchasing** : Confirm `queryPurchases()` is replaced with `queryPurchasesAsync()`.
- \[ \] **Multi-SKU Accessors** : Replace `getSku()` with `getSkus()` (returns a list) in `Purchase` objects.
- \[ \] **Subscription Refactor** : Verify `setSubscriptionUpdateParams()` is used for change logic.

## PBL v5.x Series

- \[ \] **Data Model Swap** : Replace all instances of `SkuDetails` with `ProductDetails`.
- \[ \] **Personalized Pricing** : Implement `setIsOfferPersonalized()` for EU price disclosures.

## PBL v6.x Series

- \[ \] **Replacement Mode** : Replace `ProrationMode` with the `ReplacementMode` enum.
- \[ \] **User Choice Billing** : Replace `AlternativeBillingListener` with `UserChoiceBillingListener`.

## PBL v7.x Series

- \[ \] **SDK Compliance** : `compileSdk` is set to 34 or higher.
- \[ \] **Pending Purchases** : Replace parameterless `enablePendingPurchases()` with `enablePendingPurchases(PendingPurchaseParams)`.
- \[ \] **API Cleanup** : Replace `setOldSkuPurchaseToken()` with `setOldPurchaseToken()`.

## PBL v8.x Series

- \[ \] **SDK Compliance** : `compileSdk` is set to 34 or higher.
- \[ \] **Terminology Shift**: Rename "in-app items" to "one-time products" in UI/strings.
- \[ \] **Signature Enforcement** : `onProductDetailsResponse` signature MUST be `(BillingResult, QueryProductDetailsResult)`.
- \[ \] **SUBS Offer Token** : For `SUBS` type, `ProductDetailsParams` MUST include an `offerToken`.
- \[ \] **Auto-Reconnection** : Verify `enableAutoServiceReconnection()` is used in the builder.
- \[ \] **Min SDK Increase** : Verify `minSdkVersion` is at least 23.

## PBL v9.x Series

- \[ \] **SDK Compliance** : `compileSdk` is set to 35 or higher.
- \[ \] **API Removals** : Ensure all usages of `SkuDetails`, `SkuDetailsParams`, and `SkuDetailsResponseListener` are removed and replaced with their `ProductDetails` equivalents.
- \[ \] **Blocked Store Error Handling** : If targeting restricted device modes (e.g., kids modes), ensure `androidx.core` is at v1.9+ and update error logic to catch `BILLING_UNAVAILABLE` instead of `ERROR`.
- \[ \] **External Payment Program Null-Safety** : If using developer-provided billing, update `DeveloperProvidedBillingDetails.getLinkUri()` logic to explicitly check for both `null` and empty string (`""`) values before parsing.

## Future Versions (PBL 10.0.0+)

- \[ \] **Dynamic Checklist Generation** : For any version \>=10.0.0, you **MUST** synthesize a new checklist for each new version header found in the [Release Notes](https://developer.android.com/google/play/billing/release-notes).
- \[ \] **Identify Version Delta** : Review "Breaking Changes" and "Removed APIs" for the new version and create a list of terms to `grep`.