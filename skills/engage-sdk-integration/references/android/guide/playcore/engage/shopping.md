Boost app engagement by reaching your users where they are. Integrate Engage SDK
to deliver personalized recommendations and continuation content directly to
users across multiple on-device surfaces, like
**[Collections](https://android-developers.googleblog.com/2024/07/introducing-collections-powered-by-engage-sdk.html)** , **[Entertainment
Space](https://blog.google/products/android/entertainment-space/)** , and the Play Store. The integration adds
less than 50 KB (compressed) to the average APK and takes most apps about a
week of developer time. Learn more at our **[business
site](http://play.google.com/console/about/programs/EngageSDK)**.

This guide contains instructions for developer partners to deliver shopping
content to Engage content surfaces.

## Integration detail

### Terminology

This integration includes the following five cluster types: **Recommendation** ,
**Featured** , **Shopping Cart** , **Shopping List** , **Reorder** and
**Shopping Order Tracking**.

- **Recommendation** clusters show personalized shopping suggestions from an
  individual developer partner. These recommendations can be personalized to the
  user or generalized (for example, trending items). Use these to surface
  products, events, sales, promos, subscriptions as you see fit.

  Your recommendations take the following structure:
  - **Recommendation Cluster:** A UI view that contains a group of
    recommendations from the same developer partner.

  - **ShoppingEntity:** An object representing a single item in a cluster.

- The **Featured** cluster showcases a selection of entities from multiple
  developer partners in one UI grouping. There will be a single Featured
  cluster, which is surfaced near the top of the UI with a priority placement
  above all Recommendation clusters. Each developer partner will be allowed to
  broadcast up to 10 entities in the Featured cluster.

- The **Shopping Cart** cluster shows a sneak peek of shopping carts from many
  developer partners in one UI grouping, nudging users to complete their
  outstanding carts. There is a single Shopping Cart cluster, which is
  surfaced near the top of the UI, with a priority placement above all
  Recommendation clusters. Each developer partner is allowed to broadcast up to
  3 `ShoppingCart` instances in the Shopping Cart cluster.

  Your Shopping Cart takes the following structure:
  - **Shopping Cart Cluster:** A UI view that contains a group of shopping
    cart previews from many developer partners.

  - **ShoppingCart:** An object representing the shopping cart preview
    for a single developer partner, to be displayed in the Shopping Cart
    cluster. The `ShoppingCart` must show the total count of items in the
    cart and may also include images for some items in the user's cart.

- The **Shopping List** cluster shows a sneak peek of the shopping
  lists from multiple developer partners in one UI grouping, prompting users to
  return to the corresponding app to update and complete their lists. There is a
  single Shopping List cluster.

- The **Reorder** cluster shows a sneak peek of the previous orders from
  multiple developer partners in one UI grouping, prompting users to reorder.
  There is a single Reorder cluster.

  - Reorder cluster must show the total count of items in the
    user's previous order and must also include one of the following:

    - Images for X items in the user's previous order.
    - Labels for X items in the user's previous order.
- The **Shopping Order Tracking** cluster shows a sneak peek of pending
  or recently completed shopping orders from many developer partners in one UI
  grouping, allowing users to track their orders.

  There is a single ShoppingOrderTracking cluster that is surfaced
  near the top of the UI, with a priority placement above all Recommendation
  clusters. Each developer partner is allowed to broadcast multiple
  ShoppingOrderTrackingEntity items in the Shopping Order Tracking cluster.
  - Your ShoppingOrderTrackingCluster takes the following structure:

    - **ShoppingOrderTracking Cluster**: A UI view that contains a group of order tracking previews from many developer partners
    - **ShoppingOrderTrackingEntity**: An object representing a shopping order tracking preview for a single developer partner, to be displayed in the Shopping Order Tracking cluster. The ShoppingOrderTrackingEntity must show the status of the order and the order time. We strongly recommend populating the expected delivery time for ShoppingOrderTrackingEntity, as it's displayed to users when provided.

    > [!NOTE]
    > **Note:** Provide multiple ShoppingOrderTrackingEntity objects if an order has been split into multiple shipments.

### Pre-work

Minimum API level: 19

Add the `com.google.android.engage:engage-core` library to your app:

    dependencies {
        // Make sure you also include that repository in your project's build.gradle file.
        implementation 'com.google.android.engage:engage-core:1.6.0'
    }

For more information, see [Package visibility in Android
11](https://developer.android.com/about/versions/11/privacy/package-visibility).

### Summary

The design is based on an implementation of a [bound
service](https://developer.android.com/guide/components/bound-services).

The data a client can publish is subject to the following limits for different
cluster types:

| Cluster type | Cluster limits | Maximum entity limits in a cluster |
|---|---|---|
| Recommendation Cluster(s) | At most 7 | At most 50 `ShoppingEntity` |
| Featured Cluster | At most 1 | At most 20 `ShoppingEntity` |
| Shopping Cart Cluster | At most 1 | At most 3 `ShoppingCart` Multiple carts only expected for apps with separate carts per merchant. |
| Shopping List Cluster | At most 1 | At most 3 `ShoppingList` |
| Shopping Reorder Cluster | At most 1 | At most 1 `ReorderEntity` |
| Shopping Order Tracking Cluster | At most 3 | At most 3 `ShoppingOrderTrackingEntity` |

### Step 1: Provide entity data

The SDK has defined different entities to represent each item type. The
following entities are supported for the Shopping category:

1. `ShoppingEntity`
2. `ShoppingCart`
3. `ShoppingList`
4. `Reorder`
5. `ShoppingOrderTracking`

The charts below outline available attributes and requirements for each type.

#### `ShoppingEntity`

The `ShoppingEntity` object represents a product, promotion, deal, subscription,
or event that developer partners want to publish.

##### `ShoppingEntity`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Poster images | **Required** | At least one image must be provided. | See [Image Specifications](https://developer.android.com/guide/playcore/engage/shopping#image-specs) for guidance. |
| Action Uri | **Required** | The deep link to the page in the app displaying details about the entity. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Title | Optional | The name of the entity. | Free text **Recommended text size: under 90 chars** (Text that is too long may show ellipses) |
| Price - current | Conditionally required | The current price of the entity. **Must be provided if strikethrough price is provided.** | Free text |
| Price - strikethrough | Optional | The original price of the entity, which is be struck-through in the UI. | Free text |
| Callout | Optional | Callout to feature a promo, event, or update for the entity, if available. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Callout fine print | Optional | Fine print text for the callout. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| **Rating (Optional) - Note: All ratings are displayed using our standard star rating system.** ||||
| Rating - Max value | Optional | The maximum value of the rating scale. **Must be provided if current value of rating is also provided.** | Number \>= 0.0 |
| Rating - Current value | Optional | The current value of the rating scale. **Must be provided if maximum value of rating is also provided.** | Number \>= 0.0 |
| Rating - Count | Optional | The count of the ratings for the entity. **Note:** Provide this field if your app controls how the count is displayed to the users. Use a concise string. For example, if the count is 1,000,000, consider using an abbreviation like 1M so that the count isn't truncated on smaller display sizes. | String |
| Rating - Count Value | Optional | The count of the ratings for the entity. **Note:** Provide this field if you don't handle the display abbreviation logic yourself. If both Count and Count Value are present, Count is displayed to users. | Long |
| **DisplayTimeWindow (Optional) - Set a time window for a content to be shown on the surface** ||||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |

#### `ShoppingCart`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | The deep link to the shopping cart in the partner's app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Number of items | **Required** | The number of items (not just number of products) in the shopping cart. **For example: If there are 3 identical shirts and 1 hat in the cart, this number should be 4.** | Integer \>= 1 |
| Action Text | Optional | The call to action text of the button on the Shopping Cart (for example, *Your Shopping Bag*). **If no action text is provided by the developer, *View Cart* is the default.** This attribute is supported in version 1.1.0 onwards. | String |
| Title | Optional | The title of the cart (for example, *Your Shopping Bag*). **If no title is provided by the developer, *Your cart* is the default.** **If developer partner publishes a separate cart per merchant, please include *merchant name* in the title.** | Free text **Recommended text size: under 25 chars** (Text that is too long may show ellipses) |
| Cart images | Optional | Images of each product in the cart. **Up to 10 images can be provided in order of priority; the actual number of images displayed depends on the device form factor.** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/shopping#image-specs) for guidance. |
| Item labels | Optional | The list of labels for items on the shopping list. **The actual number of labels displayed depends on the device form factor.** | List of free text labels **Recommended text size: under 20 chars** (Text that is too long may show ellipses) |
| Last user interaction timestamp | Optional | Number of milliseconds elapsed from the epoch, identifying the last time when user interacted with the cart. **This will be passed as input by the developer partners publishing separate cart per merchant and maybe used for ranking.** | Epoch timestamp in milliseconds |
| **DisplayTimeWindow (Optional) - Set a time window for a content to be shown on the surface** ||||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |

#### `ShoppingList`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | The deep link to the shopping list in the partner's app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Number of items | **Required** | The number of items in the shopping list. | Integer \>= 1 |
| Title | Optional | The title of the list (for example, *Your Grocery List*). **If no title is provided by the developer, *Shopping list* is the default.** | Free text **Recommended text size: under 25 chars** (Text that is too long may show ellipses) |
| Item labels | **Required** | The list of labels for items on the shopping list. **At least 1 label must be provided and up to 10 labels can be provided in order of priority; the actual number of labels displayed depends on the device form factor.** | List of free text labels **Recommended text size: under 20 chars** (Text that is too long may show ellipses) |
| Last user interaction timestamp | **Required** | Number of milliseconds elapsed from the epoch, identifying the last time when user interacted with the shopping list. | Epoch timestamp in milliseconds |

#### `ShoppingReorderCluster`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | The deep link to reorder in the partner's app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Action Text | Optional | The call to action text of the button on the Reorder (for example, *Order again*). **If no action text is provided by the developer, *Reorder* is the default.** This attribute is supported in version 1.1.0 onwards. | String |
| Number of items | **Required** | The number of items (not just number of products) in the previous order. **For example: If there were 3 small coffees and 1 croissant in the previous order, this number should be 4.** | Integer \>= 1 |
| Title | **Required** | The title of the reorder item. | Free text **Recommended text size: under 40 chars** (Text that is too long may show ellipses) |
| Item labels | Optional (If not provided, poster images should be provided) | The list of item labels for the previous order. **Up to 10 labels can be provided in order of priority; the actual number of labels displayed depends on the device form factor.** | List of free text **Recommended text size per label: under 20 chars** (Text that is too long may show ellipses) |
| Poster images | Optional (If not provided, item labels should be provided) | Images of the items in the previous order. **Up to 10 images can be provided in order of priority; the actual number of images displayed depends on the device form factor.** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/shopping#image-specs) for guidance. |

#### `ShoppingOrderTrackingCluster`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Title | **Required** | A short title of the package/items being tracked or the tracking number. | Free text **Recommended text size: 50 chars (Text that is too long will show ellipses)** |
| Order Type | **Required** | A short title of the package/items being tracked or the tracking number. | Enum: IN_STORE_PICKUP, SAME_DAY_DELIVERY, MULTI_DAY_DELIVERY |
| Status | **Required** | The current status of the order. **For example: "Running late", "In transit", "Delayed", "Shipped", "Delivered", "Out of stock", "Order ready"** | Free text **Recommended text size: 25 chars (Text that is too long will show ellipses)** |
| Order Time | **Required** | The epoch timestamp in milliseconds at which the order was placed. **Order time will be displayed if expected delivery time window is not present** | Epoch timestamp in milliseconds |
| Action Uri | **Required** | Deep link to the order tracking in the partner's app. | Uri |
| **OrderDeliveryTimeWindow (Optional) - Set a time window for the order that is being tracked from the time the order was placed to the time of expected/actual delivery.** ||||
| OrderDeliveryTimeWindow - Start Time | Optional | The epoch timestamp in milliseconds on/after which the order will be delivered or be ready for pickup. | Epoch timestamp in milliseconds |
| OrderDeliveryTimeWindow - End Time | Optional | The epoch timestamp in milliseconds on/before which the order will be delivered or be ready for pickup. | Epoch timestamp in milliseconds |
| Poster images | Optional | Image of one item/product that is part of the order. Recommended aspect ratio is 1:1 | See [Image Specifications](https://developer.android.com/guide/playcore/engage/shopping#image-specs) for guidance. |
| Number of items | Optional | The number of items in the order. | Integer \>= 1 |
| Description | Optional | A single paragraph of text to describe the items in the order. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size: 180 chars** |
| Subtitle list | Optional | Up to 3 subtitles, with each subtitle a single line of text. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size for each subtitle: max 50 chars** |
| Order Value - CurrentPrice | Optional | The current value of the order. | Free text |
| Order number | Optional | The order number/ID that can be used to uniquely identify the order. | Free text **Recommended text size: max 25 chars** |
| Tracking number | Optional | The tracking number for the order/parcel delivery in case the order requires a delivery. | Free text **Recommended text size: max 25 chars** |

#### Image specifications

Required specifications for image assets are listed below:

| Aspect ratio | Minimum pixels | Recommended pixels |
|---|---|---|
| Square (1x1) **Preferred for non featured clusters** | 300x300 | 1200x1200 |
| Landscape (1.91x1) **Preferred for featured clusters** | 600x314 | 1200x628 |
| Portrait (4x5) | 480x600 | 960x1200 |

*File formats*

PNG, JPG, static GIF, WebP

*Maximum file size*

5120 KB

*Additional recommendations*

- **Image safe area:** Put your important content in the center 80% of the image.
- Use a transparent background so that the image can be properly displayed in Dark and Light theme settings.

### Step 2: Provide Cluster data

It is recommended to have the content publish job executed in the background
(for example, using [WorkManager](https://developer.android.com/topic/libraries/architecture/workmanager))
and scheduled on a regular basis or on an event basis (for example, every time
the user opens the app or when the user just added something to their cart).

`AppEngageShoppingClient` is responsible for publishing shopping clusters.

Following APIs are exposed to publish clusters in the client:

- `isServiceAvailable`
- `publishRecommendationClusters`
- `publishFeaturedCluster`
- `publishShoppingCarts`
- `publishShoppingLists`
- `publishShoppingReorderCluster`
- `publishShoppingOrderTrackingCluster`
- `publishUserAccountManagementRequest`
- `updatePublishStatus`
- `deleteRecommendationsClusters`
- `deleteFeaturedCluster`
- `deleteShoppingCartCluster`
- `deleteShoppingListCluster`
- `deleteShoppingReorderCluster`
- `deleteShoppingOrderTrackingCluster`
- `deleteUserManagementCluster`
- `deleteClusters`

#### `isServiceAvailable`

This API is used to check if the service is available for integration and
whether the content can be presented on the device.

##### For Engage SDK v1.6.0 and higher (Recommended)

You can check the service availability for every cluster type that you intend to
publish. The `isServiceAvailable` API accepts a request object,
`ServiceAvailabilityRequest`, which contains the cluster types for which service
availability needs to be checked. You can find the `ClusterType` enum values
required for `ServiceAvailabilityRequest` from the following table.

| Cluster Type | Cluster Type Constant | Integer Value |
|---|---|---|
| Unknown | `TYPE_UNKNOWN` | 0 |
| Recommendation Cluster | `TYPE_RECOMMENDATION` | 1 |
| Featured Cluster | `TYPE_FEATURED` | 2 |
| Continuation Cluster | `TYPE_CONTINUATION` | 3 |
| Shopping Cart Cluster | `TYPE_SHOPPING_CART` | 4 |
| User Management Cluster | `TYPE_ENGAGEMENT` | 8 |
| Shopping List Cluster | `TYPE_SHOPPING_LIST` | 9 |
| Shopping Reorder Cluster | `TYPE_SHOPPING_REORDER` | 10 |
| Shopping Order Tracking Cluster | `TYPE_SHOPPING_ORDER_TRACKING` | 11 |
| Subscription Cluster | `TYPE_SUBSCRIPTION` | 12 |

### Kotlin

    val request = ServiceAvailabilityRequest.Builder()
        .addIntendedClusterType(ClusterType.TYPE_CONTINUATION)
        .addIntendedClusterType(ClusterType.TYPE_RECOMMENDATION)
        .build()

    client.isServiceAvailable(request).addOnCompleteListener { task ->
        if (task.isSuccessful) {
            val availabilityMap = task.result
            if (availabilityMap[ClusterType.TYPE_CONTINUATION] == true) {
                // Proceed with publishing continuation content
            }
            if (availabilityMap[ClusterType.TYPE_RECOMMENDATION] == true) {
                // Proceed with publishing recommendation content
            }
        } else {
            // The IPC call itself fails, proceed with error handling logic here,
            // such as retry.
        }
    }

### Java

    ServiceAvailabilityRequest request =
        new ServiceAvailabilityRequest.Builder()
            .addIntendedClusterType(ClusterType.TYPE_CONTINUATION)
            .addIntendedClusterType(ClusterType.TYPE_RECOMMENDATION)
            .build();

    client.isServiceAvailable(request).addOnCompleteListener(task -> {
        if (task.isSuccessful()) {
            Map<Integer, Boolean> availabilityMap = task.getResult();
            if (Boolean.TRUE.equals(availabilityMap.get(ClusterType.TYPE_CONTINUATION))) {
                // Proceed with publishing continuation content
            }
            if (Boolean.TRUE.equals(availabilityMap.get(ClusterType.TYPE_RECOMMENDATION))) {
                // Proceed with publishing recommendation content
            }
        } else {
            // The IPC call itself fails, proceed with error handling logic here,
            // such as retry.
        }
    });

###### Conditional Service Availability Feature

Some integrated apps request a special configuration that enables and disables
the Engage service intermittently in order to reduce their serving cost. This
intermittent content ingestion strategy, although possible, negatively affects
the user and the product -- stale content will not be presented and some surfaces
will not be served at all.

Starting with v1.6.0, the Engage SDK allows checking availability for specific
cluster types. This provides more flexibility so that if the intermittent
content strategy was adopted by a given application, some cluster types can
follow that intermittent strategy while other cluster types are always enabled
(i.e. continuation clusters).

If the Engage service should not be 'continuously' enabled on all supported
devices for whatever reason, and is configured for intermittent ingestion for
any set of devices, all continuation cluster publications (e.g. Shopping
Cart, Shopping List, Reorder, and Shopping Order Tracking) will be still
enabled by default configuration, and the rest of the cluster types will be
enabled and disabled intermittently. If intermittent ingestion applies to
you but this default configuration is not suitable for your needs, please
contact engage-developers@google.com.

##### For SDK versions prior to v1.6.0 (Deprecated)

### Kotlin

    client.isServiceAvailable.addOnCompleteListener { task ->
        if (task.isSuccessful) {
            // Handle IPC call success
            if(task.result) {
              // Service is available on the device, proceed with content publish
              // calls.
            } else {
              // Service is not available, no further action is needed.
            }
        } else {
          // The IPC call itself fails, proceed with error handling logic here,
          // such as retry.
        }
    }

### Java

    client.isServiceAvailable().addOnCompleteListener(task - > {
        if (task.isSuccessful()) {
            // Handle success
            if(task.getResult()) {
              // Service is available on the device, proceed with content publish
              // calls.
            } else {
              // Service is not available, no further action is needed.
            }
        } else {
          // The IPC call itself fails, proceed with error handling logic here,
          // such as retry.
        }
    });

> [!NOTE]
> **Note:** We highly recommend keeping a periodic job running to check if the service becomes available at a later point in time. The availability of the service may change with Android version upgrades, app upgrades, installs, and uninstalls. By ensuring periodic job checks at a certain time interval, data can be published once the service becomes available.

#### `publishRecommendationClusters`

This API is used to publish a list of `RecommendationCluster` objects.

A `RecommendationCluster` object can have the following attributes:

| Attribute | Requirement | Description |
|---|---|---|
| List of ShoppingEntity | **Required** | A list of ShoppingEntity objects that make up the recommendations for this Recommendation Cluster. |
| Title | **Required** | The title for the Recommendation Cluster. **Recommended text size: under 25 chars** (Text that is too long may show ellipses) |
| Subtitle | Optional | The subtitle for the Recommendation Cluster. |
| Action Uri | Optional | The deep link to the page in the partner app where users can see the complete list of recommendations. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishRecommendationClusters(
                PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Black Friday Deals")
                            .build())
                    .build())

### Java

    client.publishRecommendationClusters(
                new PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        new RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Black Friday Deals")
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- All existing Recommendation Cluster data is removed.
- Data from the request is parsed and stored in new Recommendation Clusters.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishFeaturedCluster`

This API is used to publish a `FeaturedCluster` object.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishFeaturedCluster(
                PublishFeaturedClusterRequest.Builder()
                    .setFeaturedCluster(
                        FeaturedCluster.Builder()
                            ...
                            .build())
                    .build())

### Java

    client.publishFeaturedCluster(
                new PublishFeaturedClusterRequest.Builder()
                    .setFeaturedCluster(
                        new FeaturedCluster.Builder()
                            ...
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `FeaturedCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Featured Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishShoppingCarts`

This API is used to publish a list of `ShoppingCart` objects. This is
applicable to developer partner publishing separate carts per merchant. Include
merchant name in the title when using this API.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishShoppingCarts(
                PublishShoppingCartClustersRequest.Builder()
                    .addShoppingCart(
                        ShoppingCart.Builder()
                            ...
                            .build())
                    .build())

### Java

    client.publishShoppingCarts(
                new PublishShoppingCartClustersRequest.Builder()
                    .addShoppingCart(
                        new ShoppingCart.Builder()
                            ...
                            .build())
                    .build())

When the service receives the request, the following actions take place within
one transaction:

- Existing `ShoppingCart` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Shopping Cart Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishShoppingLists`

This API is used to publish a list of `ShoppingList` objects.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishShoppingLists(
                PublishShoppingListsRequest.Builder()
                    .addShoppingList(
                        ShoppingList.Builder()
                            ...
                            .build())
                    .build())

### Java

    client.publishShoppingLists(
                new PublishShoppingListsRequest.Builder()
                    .addShoppingList(
                        new ShoppingListEntity.Builder()
                            ...
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `ShoppingList` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Shopping List Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishShoppingReorderCluster`

This API is used to publish a `ShoppingReorderCluster` object.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishShoppingReorderCluster(
                PublishShoppingReorderClusterRequest.Builder()
                    .setReorderCluster(
                        ShoppingReorderCluster.Builder()
                            ...
                            .build())
                    .build())

### Java

    client.publishShoppingReorderCluster(
                new PublishShoppingReorderClusterRequest.Builder()
                    .setReorderCluster(
                        new ShoppingReorderCluster.Builder()
                            ...
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `ShoppingReorderCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Reorder Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishShoppingOrderTrackingCluster`

This API is used to publish a `ShoppingOrderTrackingCluster` object.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishShoppingOrderTrackingCluster(
                PublishShoppingOrderTrackingClusterRequest.Builder()
                    .setShoppingOrderTrackingCluster(
                        ShoppingOrderTrackingCluster.Builder()
                            ...
                            .build())
                    .build())

### Java

    client.publishShoppingOrderTrackingCluster(
                new PublishShoppingOrderTrackingClusterRequest.Builder()
                    .setShoppingOrderTrackingCluster(
                        new ShoppingOrderTrackingCluster.Builder()
                            ...
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `ShoppingOrderTrackingCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Shopping Order Tracking Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishUserAccountManagementRequest`

This API is used to publish a Sign In card . The signin action directs users to
the app's sign in page so that the app can publish content (or provide more
personalized content)

The following metadata is part of the Sign In Card -

| Attribute | Requirement | Description |
|---|---|---|
| Action Uri | Required | Deeplink to Action (i.e. navigates to app sign in page) |
| Image | Optional - If not provided, Title must be provided | Image Shown on the Card 16x9 aspect ratio images with a resolution of 1264x712 |
| Title | Optional - If not provided, Image must be provided | Title on the Card |
| Action Text | Optional | Text Shown on the CTA (i.e. Sign in) |
| Subtitle | Optional | Optional Subtitle on the Card |

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    var SIGN_IN_CARD_ENTITY =
          SignInCardEntity.Builder()
              .addPosterImage(
                  Image.Builder()
                      .setImageUri(Uri.parse("http://www.x.com/image.png"))
                      .setImageHeightInPixel(500)
                      .setImageWidthInPixel(500)
                      .build())
              .setActionText("Sign In")
              .setActionUri(Uri.parse("http://xx.com/signin"))
              .build()

    client.publishUserAccountManagementRequest(
                PublishUserAccountManagementRequest.Builder()
                    .setSignInCardEntity(SIGN_IN_CARD_ENTITY)
                    .build());

### Java

    SignInCardEntity SIGN_IN_CARD_ENTITY =
          new SignInCardEntity.Builder()
              .addPosterImage(
                  new Image.Builder()
                      .setImageUri(Uri.parse("http://www.x.com/image.png"))
                      .setImageHeightInPixel(500)
                      .setImageWidthInPixel(500)
                      .build())
              .setActionText("Sign In")
              .setActionUri(Uri.parse("http://xx.com/signin"))
              .build();

    client.publishUserAccountManagementRequest(
                new PublishUserAccountManagementRequest.Builder()
                    .setSignInCardEntity(SIGN_IN_CARD_ENTITY)
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `UserAccountManagementCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated UserAccountManagementCluster Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `updatePublishStatus`

If for any internal business reason, none of the clusters is published,
we **strongly recommend** updating the publish status using the
**updatePublishStatus** API.
This is important because :

- Providing the status in all scenarios, even when the content is published (STATUS == PUBLISHED), is critical to populate dashboards that use this explicit status to convey the health and other metrics of your integration.
- If no content is published but the integration status isn't broken (STATUS == NOT_PUBLISHED), Google can avoid triggering alerts in the app health dashboards. It confirms that content is not published due to an **expected** situation from the provider's standpoint.
- It helps developers provide insights into when the data is published versus not.
- Google may use the status codes to nudge the user to do certain actions in the app so they can see the app content or overcome it.

The list of eligible publish status codes are :

    // Content is published
    AppEngagePublishStatusCode.PUBLISHED,

    // Content is not published as user is not signed in
    AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SIGN_IN,

    // Content is not published as user is not subscribed
    AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SUBSCRIPTION,

    // Content is not published as user location is ineligible
    AppEngagePublishStatusCode.NOT_PUBLISHED_INELIGIBLE_LOCATION,

    // Content is not published as there is no eligible content
    AppEngagePublishStatusCode.NOT_PUBLISHED_NO_ELIGIBLE_CONTENT,

    // Content is not published as the feature is disabled by the client
    // Available in v1.3.1
    AppEngagePublishStatusCode.NOT_PUBLISHED_FEATURE_DISABLED_BY_CLIENT,

    // Content is not published as the feature due to a client error
    // Available in v1.3.1
    AppEngagePublishStatusCode.NOT_PUBLISHED_CLIENT_ERROR,

    // Content is not published as the feature due to a service error
    // Available in v1.3.1
    AppEngagePublishStatusCode.NOT_PUBLISHED_SERVICE_ERROR,

    // Content is not published due to some other reason
    // Reach out to engage-developers@ before using this enum.
    AppEngagePublishStatusCode.NOT_PUBLISHED_OTHER

If the content is not published due to a user not logged in,
Google would recommend publishing the Sign In Card.
If for any reason providers are not able to publish the Sign In Card
then we recommend calling the **updatePublishStatus** API
with the status code **NOT_PUBLISHED_REQUIRES_SIGN_IN**

### Kotlin

    client.updatePublishStatus(
       PublishStatusRequest.Builder()
         .setStatusCode(AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SIGN_IN)
         .build())

### Java

    client.updatePublishStatus(
        new PublishStatusRequest.Builder()
            .setStatusCode(AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SIGN_IN)
            .build());

#### `deleteRecommendationClusters`

This API is used to delete the content of Recommendation Clusters.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteRecommendationClusters()

### Java

    client.deleteRecommendationClusters();

When the service receives the request, it removes the existing data from the
Recommendation Clusters. In case of an error, the entire request is rejected
and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteFeaturedCluster`

This API is used to delete the content of Featured Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteFeaturedCluster()

### Java

    client.deleteFeaturedCluster();

When the service receives the request, it removes the existing data from the
Featured Cluster. In case of an error, the entire request is rejected
and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteShoppingCartCluster`

This API is used to delete the content of Shopping Cart Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteShoppingCartCluster()

### Java

    client.deleteShoppingCartCluster();

When the service receives the request, it removes the existing data from the
Shopping Cart Cluster. In case of an error, the entire request is rejected
and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteShoppingListCluster`

This API is used to delete the content of Shopping List Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteShoppingListCluster()

### Java

    client.deleteShoppingListCluster();

When the service receives the request, it removes the existing data from the
Shopping List Cluster. In case of an error, the entire request is rejected
and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteShoppingReorderCluster`

This API is used to delete the content of Shopping Reorder Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteShoppingReorderCluster()

### Java

    client.deleteShoppingReorderCluster();

When the service receives the request, it removes the existing data from the
Shopping Reorder Cluster. In case of an error, the entire request is rejected
and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteShoppingOrderTrackingCluster`

This API is used to delete the content of Shopping Order Tracking Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteShoppingOrderTrackingCluster()

### Java

    client.deleteShoppingOrderTrackingCluster();

When the service receives the request, it removes the existing data from the
Shopping Order Tracking Cluster. In case of an error, the entire request is
rejected and the existing state is maintained.

> [!NOTE]
> **Note:** This API is available in versions 1.4.0 and higher.

#### `deleteUserManagementCluster`

This API is used to delete the content of UserAccountManagement Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteUserManagementCluster()

### Java

    client.deleteUserManagementCluster();

When the service receives the request, it removes the existing data from the
UserAccountManagement Cluster. In case of an error, the entire request is
rejected and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteClusters`

This API is used to delete the content of a given cluster type.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteClusters(
        DeleteClustersRequest.Builder()
          .addClusterType(ClusterType.TYPE_FEATURED)
          .addClusterType(ClusterType.TYPE_RECOMMENDATION)
          ...
          .build())

### Java

    client.deleteClusters(
                new DeleteClustersRequest.Builder()
                    .addClusterType(ClusterType.TYPE_FEATURED)
                    .addClusterType(ClusterType.TYPE_RECOMMENDATION)
                    ...
                    .build());

When the service receives the request, it removes the existing data from all
clusters matching the specified cluster types. Clients can choose to pass one or
many cluster types. In case of an error, the entire request is rejected and the
existing state is maintained.

#### Error handling

It is highly recommended to listen to the task result from the publish APIs such
that a follow-up action can be taken to recover and resubmit an successful task.

### Kotlin

    client.publishRecommendationClusters(
            PublishRecommendationClustersRequest.Builder()
              .addRecommendationCluster(..)
              .build())
          .addOnCompleteListener { task ->
            if (task.isSuccessful) {
              // do something
            } else {
              val exception = task.exception
              if (exception is AppEngageException) {
                @AppEngageErrorCode val errorCode = exception.errorCode
                if (errorCode == AppEngageErrorCode.SERVICE_NOT_FOUND) {
                  // do something
                }
              }
            }
          }

### Java

    client.publishRecommendationClusters(
                  new PublishRecommendationClustersRequest.Builder()
                      .addRecommendationCluster(...)
                      .build())
              .addOnCompleteListener(
                  task -> {
                    if (task.isSuccessful()) {
                      // do something
                    } else {
                      Exception exception = task.getException();
                      if (exception instanceof AppEngageException) {
                        @AppEngageErrorCode
                        int errorCode = ((AppEngageException) exception).getErrorCode();
                        if (errorCode == AppEngageErrorCode.SERVICE_NOT_FOUND) {
                          // do something
                        }
                      }
                    }
                  });

The error is returned as an `AppEngageException` with the cause included as an
error code.

| Error code | Error name | Note |
|---|---|---|
| `1` | `SERVICE_NOT_FOUND` | The service is not available on the given device. |
| `2` | `SERVICE_NOT_AVAILABLE` | The service is available on the given device, but it is not available at the time of the call (for example, it is explicitly disabled). |
| `3` | `SERVICE_CALL_EXECUTION_FAILURE` | The task execution failed due to threading issues. In this case, it can be retried. |
| `4` | `SERVICE_CALL_PERMISSION_DENIED` | The caller is not allowed to make the service call. |
| `5` | `SERVICE_CALL_INVALID_ARGUMENT` | The request contains invalid data (for example, more than the allowed number of clusters). |
| `6` | `SERVICE_CALL_INTERNAL` | There is an error on the service side. |
| `7` | `SERVICE_CALL_RESOURCE_EXHAUSTED` | The service call is made too frequently. |

### Step 3: Handle broadcast intents

In addition to making publish content API calls through a job, it is also
required to set up a
[`BroadcastReceiver`](https://developer.android.com/reference/android/content/BroadcastReceiver) to receive
the request for a content publish.

The goal of broadcast intents is mainly for app reactivation and forcing data
sync. Broadcast intents are not designed to be sent very frequently. It is only
triggered when the Engage Service determines the content might be stale (for
example, a week old). That way, there is more confidence that the user can have
a fresh content experience, even if the application has not been executed for a
long period of time.

The `BroadcastReceiver` must be set up in the following two ways:

- Dynamically register an instance of the `BroadcastReceiver` class using
  `Context.registerReceiver()`. This enables communication from applications
  that are still live in memory.

### Kotlin

    class AppEngageBroadcastReceiver : BroadcastReceiver(){
      // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION
      // broadcast is received
      // Trigger featured cluster publish when PUBLISH_FEATURED broadcast is
      // received
      // Trigger shopping cart cluster publish when PUBLISH_SHOPPING_CART broadcast
      // is received
      // Trigger shopping list cluster publish when PUBLISH_SHOPPING_LIST broadcast
      // is received
      // Trigger reorder cluster publish when PUBLISH_REORDER_CLUSTER broadcast is
      // received
      // Trigger shopping order tracking cluster publish when
      // PUBLISH_SHOPPING_ORDER_TRACKING_CLUSTER broadcast is received
    }

    fun registerBroadcastReceivers(context: Context){
      var  context = context
      context = context.applicationContext

    // Register Recommendation Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_RECOMMENDATION),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register Featured Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_FEATURED),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register Shopping Cart Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_SHOPPING_CART),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register Shopping List Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_SHOPPING_LIST),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register Reorder Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_REORDER_CLUSTER),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register Shopping Order Tracking Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_SHOPPING_ORDER_TRACKING_CLUSTER),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)
    }

### Java

    class AppEngageBroadcastReceiver extends BroadcastReceiver {
    // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION broadcast
    // is received

    // Trigger featured cluster publish when PUBLISH_FEATURED broadcast is received

    // Trigger shopping cart cluster publish when PUBLISH_SHOPPING_CART broadcast is
    // received

    // Trigger shopping list cluster publish when PUBLISH_SHOPPING_LIST broadcast is
    // received

    // Trigger reorder cluster publish when PUBLISH_REORDER_CLUSTER broadcast is
    // received

    // Trigger reorder cluster publish when PUBLISH_SHOPPING_ORDER_TRACKING_CLUSTER
    // broadcast is received
    }

    public static void registerBroadcastReceivers(Context context) {

    context = context.getApplicationContext();

    // Register Recommendation Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.service.Intents.ACTION_PUBLISH_RECOMMENDATION),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register Featured Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.service.Intents.ACTION_PUBLISH_FEATURED),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register Shopping Cart Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.shopping.service.Intents.ACTION_PUBLISH_SHOPPING_CART),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register Shopping List Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.shopping.service.Intents.ACTION_PUBLISH_SHOPPING_LIST),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register Reorder Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.shopping.service.Intents.ACTION_PUBLISH_REORDER_CLUSTER),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register Shopping Order Tracking Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.shopping.service.Intents.ACTION_PUBLISH_SHOPPING_ORDER_TRACKING_CLUSTER),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    }

- Statically declare an implementation with the `<receiver>` tag in your
  `AndroidManifest.xml` file. This allows the application to receive broadcast
  intents when it is not running, and also allows the application to publish
  the content.

    <application>
       <receiver
          android:name=".AppEngageBroadcastReceiver"
          android:permission="com.google.android.engage.REQUEST_ENGAGE_DATA"
          android:exported="true"
          android:enabled="true">
          <intent-filter>
             <action android:name="com.google.android.engage.action.PUBLISH_RECOMMENDATION" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.PUBLISH_FEATURED" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.shopping.PUBLISH_SHOPPING_CART" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.shopping.PUBLISH_SHOPPING_LIST" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.shopping.PUBLISH_REORDER_CLUSTER" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.shopping.PUBLISH_SHOPPING_ORDER_TRACKING_CLUSTER" />
          </intent-filter>
       </receiver>
    </application>

The following [intents](https://developer.android.com/reference/android/content/Intent) are sent by the
service:

- `com.google.android.engage.action.PUBLISH_RECOMMENDATION` It is recommended to start a `publishRecommendationClusters` call when this intent is received.
- `com.google.android.engage.action.PUBLISH_FEATURED` It is recommended to start a `publishFeaturedCluster` call when this intent is received.
- `com.google.android.engage.action.shopping.PUBLISH_SHOPPING_CART` It is recommended to start a `publishShoppingCarts` call when this intent is received.
- `com.google.android.engage.action.shopping.PUBLISH_SHOPPING_LIST` It is recommended to start a `publishShoppingLists` call when this intent is received.
- `com.google.android.engage.action.shopping.PUBLISH_REORDER_CLUSTER` It is recommended to start a `publishReorderCluster` call when this intent is received.
- `com.google.android.engage.action.shopping.PUBLISH_SHOPPING_ORDER_TRACKING_CLUSTER` It is recommended to start a `publishShoppingOrderTrackingCluster` call when this intent is received.

## Integration workflow

For a step-by-step guide on verifying your integration after it is complete, see
[Engage developer integration workflow](https://developer.android.com/guide/playcore/engage/workflow).

## FAQs

See [Engage SDK Frequently Asked Questions](https://developer.android.com/guide/playcore/engage/faq) for
FAQs.

## Contact

Contact
[`engage-developers@google.com`](mailto:engage-developers@google.com) if there are
any questions during the integration process. Our team replies as soon as
possible.

## Next steps

After completing this integration, your next steps are as follows:

- Send an email to [`engage-developers@google.com`](mailto:engage-developers@google.com) and attach your integrated APK that is ready for testing by Google.
- Google performs a verification and reviews internally to make sure the integration works as expected. If changes are needed, Google contacts you with any necessary details.
- When testing is complete and no changes are needed, Google contacts you to notify you that you can start publishing the updated and integrated APK to the Play Store.
- After Google has confirmed that your updated APK has been published to the Play Store, your **Recommendation** , **Featured** , **Shopping Cart** , **Shopping List** , **Reorder Cluster** and **Shopping Order Tracking Cluster** clusters may be published and visible to users.