This guide contains instructions for developers to share app subscription and
entitlement data with Google TV using [Engage SDK](https://developer.android.com/guide/playcore/engage). Users can find
content they are entitled to and enable Google TV to deliver highly relevant
content recommendations to users, directly within Google TV experiences on TV,
mobile, and tablet.

## Prerequisites

> [!IMPORTANT]
> **Important:** [Express interest in developing with Engage](http://g.co/tv/vda).

Onboarding the media actions feed is required before you can use the device
entitlement API. If you haven't already done so, complete the [media actions
feed](https://developers.google.com/actions/media?authuser=0) onboarding process.

## Pre-work

Complete the [Pre-work](https://developer.android.com/guide/playcore/engage/tv/getting-started#pre-work) instructions in the Getting Started guide.

1. Publish subscription information on the following events:
   1. User logs in to your app.
   2. User switches between profiles (if profiles are supported).
   3. User purchases a new subscription.
   4. User upgrades an existing subscription.
   5. User subscription expires.

## Integration

This section provides the necessary code examples and instructions for
implementing `SubscriptionEntity` to manage various subscription types.

### Common tier subscription

For users with basic subscriptions to media provider services, for example, a
service that has one subscription tier that grants access to all the paid
content, provide these essential details:

1. `SubscriptionType`: Clearly indicate the specific subscription plan the user
   has.

   - `SUBSCRIPTION_TYPE_ACTIVE`: User has an active paid subscription.
   - `SUBSCRIPTION_TYPE_ACTIVE_TRIAL`: User has a trial subscription.
   - `SUBSCRIPTION_TYPE_INACTIVE`: User has an account but no active subscription or trial.

   > [!IMPORTANT]
   > **Important:** Only users with `SUBSCRIPTION_TYPE_ACTIVE` or `SUBSCRIPTION_TYPE_ACTIVE_TRIAL` are eligible for personalized content recommendations based on their subscription.

2. `ExpirationTimeMillis`: Optional time in milliseconds. Specify when the
   subscription is set to expire.

3. `ProviderPackageName`: Specify the package name of the app that handles the
   subscription.

Example for the sample media provider feed.

    "actionAccessibilityRequirement": [
      {
        "@type": "ActionAccessSpecification",
        "category": "subscription",
        "availabilityStarts": "2022-06-01T07:00:00Z",
        "availabilityEnds": "2026-05-31T07:00:00Z",
        "requiresSubscription": {
        "@type": "MediaSubscription",
        // Don't match this string,
        // ID is only used to for reconciliation purpose
        "@id": "https://www.example.com/971bfc78-d13a-4419",
        // Don't match this, as name is only used for displaying purpose
        "name": "Basic common name",
        "commonTier": true
      }

The following example creates a `SubscriptionEntity` for a user:

    val subscription = SubscriptionEntity.Builder()
      setSubscriptionType(
        SubscriptionType.SUBSCRIPTION_TYPE_ACTIVE
      )
      .setProviderPackageName("com.google.android.example")
      // Optional
      // December 30, 2025 12:00:00AM in milliseconds since epoch
      .setExpirationTimeMillis(1767052800000)
      .build()

### Premium subscription

If app offer multi-tiered premium subscription packages, which includes expanded
content or features beyond the common tier, represent this by adding one or more
entitlements to Subscription.

This entitlement has the following fields:

1. `Identifier`: Required identifier string for this entitlement. This must match one of the [entitlement identifiers](https://developers.google.com/actions/media/concepts/access-requirements#entitlement-identifier) (note that this isn't the ID field) provided in the media provider's feed published to Google TV.
2. `Name`: This is auxiliary information and is used for entitlement matching. While optional, providing a human readable entitlement name enhances understanding of user entitlements for both developers and support teams. For example: Sling Orange.
3. `ExpirationTimeMillis`: Optionally specify the expiration time in milliseconds for this entitlement, if it differs from the subscription expiration time. By default, the entitlement will expire with the expiry of subscription.

For the following sample media provider feed snippet:

    "actionAccessibilityRequirement": [
      {
        "@type": "ActionAccessSpecification",
        "category": "subscription",
        "availabilityStarts": "2022-06-01T07:00:00Z",
        "availabilityEnds": "2026-05-31T07:00:00Z",
        "requiresSubscription": {
        "@type": "MediaSubscription",
        // Don't match this string,
        // ID is only used to for reconciliation purpose
        "@id": "https://www.example.com/971bfc78-d13a-4419",

        // Don't match this, as name is only used for displaying purpose
        "name": "Example entitlement name",
        "commonTier": false,
        // match this identifier in your API. This is the crucial
        // entitlement identifier used for recommendation purpose.
        "identifier": "example.com:entitlementString1"
      }

The following example creates a `SubscriptionEntity` for a subscribed user:

    // Subscription with entitlements.
    // The entitlement expires at the same time as its subscription.
    val subscription = SubscriptionEntity.Builder()
      .setSubscriptionType(
        SubscriptionType.SUBSCRIPTION_TYPE_ACTIVE
      )
      .setProviderPackageName("com.google.android.example")
      // Optional
      // December 30, 2025 12:00:00AM in milliseconds
      .setExpirationTimeMillis(1767052800000)
      .addEntitlement(
        SubscriptionEntitlement.Builder()
        // matches with the identifier in media provider feed
        .setEntitlementId("example.com:entitlementString1")
        .setDisplayName("entitlement name1")
        .build()
      )
      .build()

    // Subscription with entitlements
    // The entitement has different expiration time from its subscription
    val subscription = SubscriptionEntity.Builder()
      .setSubscriptionType(
        SubscriptionType.SUBSCRIPTION_TYPE_ACTIVE
      )
      .setProviderPackageName("com.google.android.example")
      // Optional
      // December 30, 2025 12:00:00AM in milliseconds
      .setExpirationTimeMillis(1767052800000)
      .addEntitlement(
        SubscriptionEntitlement.Builder()
        .setEntitlementId("example.com:entitlementString1")
        .setDisplayName("entitlement name1")
        // You may set the expiration time for entitlement
        // December 15, 2025 10:00:00 AM in milliseconds
        .setExpirationTimeMillis(1765792800000)
        .build())
      .build()

### Subscription for linked service package

While subscriptions typically belong to the originating app's media provider, a
subscription can be attributed to a linked service package by specifying the
linked service package name within the subscription.

Following code sample demonstrate how to create user subscription.

    // Subscription for linked service package
    val subscription = SubscriptionEntity.Builder()
      .setSubscriptionType(
        SubscriptionType.SUBSCRIPTION_TYPE_ACTIVE
      )
      .setProviderPackageName("com.google.android.example")
      // Optional
      // December 30, 2025 12:00:00AM in milliseconds since epoch
      .setExpirationTimeMillis(1767052800000)
      .build()

In addition, if the user has another subscription to a subsidiary service, add
another subscription and set the linked service package name accordingly.

    // Subscription for linked service package
    val linkedSubscription = Subscription.Builder()
      .setSubscriptionType(
        SubscriptionType.SUBSCRIPTION_TYPE_ACTIVE
      )
      .setProviderPackageName("linked service package name")
      // Optional
      // December 30, 2025 12:00:00AM in milliseconds since epoch
      .setExpirationTimeMillis(1767052800000)
      .addBundledSubscription(
        BundledSubscription.Builder()
          .setBundledSubscriptionProviderPackageName(
            "bundled-subscription-package-name"
          )
          .setSubscriptionType(SubscriptionType.SUBSCRIPTION_TYPE_ACTIVE)
          .setExpirationTimeMillis(111)
          .addEntitlement(
            SubscriptionEntitlement.Builder()
            .setExpirationTimeMillis(111)
            .setDisplayName("Silver subscription")
            .setEntitlementId("subscription.tier.platinum")
            .build()
          )
          .build()
      )
        .build()

Optionally, add entitlements to a linked service subscription too.

### Provide subscription set

Run the content publish job while the app is in the foreground.

Use the `publishSubscriptionCluster()` method, from the
`AppEngagePublishClient` class, to publish a `SubscriptionCluster` object.

Make sure to initialize the client and check for service availability as
described in the [Getting Started guide](https://developer.android.com/guide/playcore/engage/tv/getting-started#common-integration).

    client.publishSubscription(
      PublishSubscriptionRequest.Builder()
        .setAccountProfile(accountProfile)
        .setSubscription(subscription)
        .build()
      )

Use `setSubscription()` to verify that user should have only one subscription to
the service.

Use `addLinkedSubscription()`, or `addLinkedSubscriptions()` which accept a list
of linked subscriptions, to enable user to have zero or more linked
subscriptions.

When the service receives the request, a new entry is created and the old entry
is automatically deleted after 60 days. The system always uses the latest entry.
In case of an error, the entire request is rejected and the existing state is
maintained.

### Keep subscription up-to-date

1. To provide immediate updates upon changes, call
   `publishSubscriptionCluster` whenever a user's subscription state changes
   like activation, deactivation, upgrades, downgrades.

2. To provide regular validation for ongoing accuracy, call
   `publishSubscriptionCluster` at least once per month.

   > [!NOTE]
   > **Note:** As Google TV automatically deletes historical data beyond 60 days to safeguard user privacy, publishing user subscription data at least once per month verify the validity of data. Unlike `publishContinuationCluster` for continue watching data, don't set `syncAcrossDevices` flag, as subscription information is by default used to provide content across all devices.

3. To delete the Engage data, manually delete a user's data from the
   Google TV server before the standard 60-day retention period, use the
   `client.deleteClusters` method. This deletes all existing Engage
   data for the account profile, or for the entire account depending on the
   given [`DeleteReason`](https://developer.android.com/reference/com/google/android/engage/service/DeleteReason).

   The following code snippet shows how to remove a user subscription:

       // If the user logs out from your media app, you must make the following call
       // to remove subscription and other Engage data from the current
       // google TV device.
       client.deleteClusters(
         new DeleteClustersRequest.Builder()
           .setAccountProfile(accountProfile)
         .setReason(DeleteReason.DELETE_REASON_USER_LOG_OUT)
         .build()
         )

   The following code snippet demonstrates removal of user subscription
   when user revokes the consent:

       // If the user revokes the consent to share across device, make the call
       // to remove subscription and other Engage data from all google
       // TV devices.
       client.deleteClusters(
         new DeleteClustersRequest.Builder()
           .setAccountProfile(accountProfile)
           .setReason(DeleteReason.DELETE_REASON_LOSS_OF_CONSENT)
           .build()
       )

   Following code demonstrates how to remove subscription data on user profile
   deletion.

       // If the user delete a specific profile, you must make the following call
       // to remove subscription data and other Engage data.
       client.deleteClusters(
         new DeleteClustersRequest.Builder()
         .setAccountProfile(accountProfile)
         .setReason(DeleteReason.DELETE_REASON_ACCOUNT_PROFILE_DELETION)
         .build()
       )

### Testing

This section provides a step-by-step guide for testing subscription
implementation. Verify data accuracy and proper functionality before launch.

#### Publish Integration checklist

1. Publishing should happen when the app is in the foreground and user the
   actively interacting with it.

2. Publish when:

   - User logs in for the first time.
   - User changes profile (if profiles are supported).
   - User purchases new subscription.
   - User upgrades subscription.
   - User subscription expires.
3. Check if app is correctly calling `isServiceAvailable()` and
   `publishClusters()` APIs in logcat, on the publishing events.

4. Verify that data is visible in the verification app. The verification app
   should display subscription as a separate row. When the publish API is
   invoked, the data should show up in the verification app.

   > [!IMPORTANT]
   > **Important:** Verify that the [Engage Service Flag](https://developer.android.com/guide/playcore/engage/workflow#switch-to-prod) is **not** set to production.

5. Go to app and perform each of the following actions:

   - Sign in.
   - Switch between profiles (if supported).
   - Purchase a new subscription.
   - Upgrade an existing subscription.
   - Expire the subscription.

#### Verify integration

To test your integration, use the [verification app](https://developer.android.com/guide/playcore/engage/tv/getting-started#testing).

1. For each of the events, check if app has invoked the `publishSubscription` API. Verify the published data in the verification app. **Verify that everything is green in verification app**
2. If all the entity's information is correct, it shows an "All Good" green
   check in all entities.

   ![Verification App Success Screenshot](https://developer.android.com/static/images/guide/playcore/engage/ett-va-success.png) **Figure 1.** Successful subscription
3. Problems are also highlighted in verification app

   ![Verification App Error Screenshot](https://developer.android.com/static/images/guide/playcore/engage/ett-va-error.png) **Figure 2.**Subscription unsuccessful
4. To see the problems in the bundled subscription, use the TV remote to focus
   on that specific bundled subscription and click to see the problems. You
   might have to first focus on the row and move to the right to find Bundled
   Subscription card. The problems are highlighted as red as shown in Fig 3.
   Also, use the remote to move down to see problems in the entitlements within
   bundled subscription

   ![Verification App Error Details Screenshot](https://developer.android.com/static/images/guide/playcore/engage/ett-va-error-details.png) **Figure 3.**Subscription Errors
5. To see the problems in the entitlement, use the TV remote to focus on that
   specific entitlement and click to see the problems. The problems are
   highlighted as red.

   ![Verification App Error Screenshot](https://developer.android.com/static/images/guide/playcore/engage/ett-va-details.png) **Figure 4.**Subscription Error Details