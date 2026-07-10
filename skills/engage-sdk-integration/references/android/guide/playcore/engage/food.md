Boost app engagement by reaching your users where they are. Integrate Engage SDK
to deliver personalized recommendations and continuation content directly to
users across multiple on-device surfaces, like
**[Collections](https://android-developers.googleblog.com/2024/07/introducing-collections-powered-by-engage-sdk.html)** , **[Entertainment
Space](https://blog.google/products/android/entertainment-space/)** , and the Play Store. The integration adds
less than 50 KB (compressed) to the average APK and takes most apps about a
week of developer time. Learn more at our **[business
site](http://play.google.com/console/about/programs/EngageSDK)**.

This guide contains instructions for developer partners to deliver food content
(food ordering, food or restaurant reviews \& discovery, meal subscriptions,
recipes) to Engage content surfaces.

## Integration detail

### Terminology

This integration includes the following five cluster types: **Recommendation** ,
**Featured** , **Food Shopping Cart** , **Food Shopping List** , and **Reorder**.

- **Recommendation** clusters show personalized food-related suggestions from an
  individual developer partner. These recommendations can be personalized to the
  user or generalized (for example, new on sale). Use them to surface recipes,
  stores, dishes, groceries, and so on as you see fit.

  - A Recommendation cluster can be made of `ProductEntity`, `StoreEntity`, or `RecipeEntity` listings, but not a mix of different entity types.

  ![](https://developer.android.com/static/images/guide/playcore/engage/food-entities.png) **Figure :**\`ProductEntity\`, \`StoreEntity\`, and \`RecipeEntity\`. (\*UI for illustrative purposes only)
- The **Featured** cluster showcases a selection of entities from multiple
  developer partners in one UI grouping. There will be a single Featured
  cluster, which is surfaced near the top of the UI with a priority placement
  above all Recommendation clusters. Each developer partner will be allowed to
  broadcast up to 10 entities in the Featured cluster.

  ![](https://developer.android.com/static/images/guide/playcore/engage/food-featured.png) **Figure :** Featured cluster with the \`RecipeEntity\`. (\*UI for illustrative purposes only)
- The **Food Shopping Cart** cluster shows a sneak peek of grocery shopping
  carts from multiple developer partners in one UI grouping, prompting users to
  complete their outstanding carts. There is a single Food Shopping Cart
  cluster.

  - Food Shopping Cart Cluster must show the total count of items in the
    cart and may also include images for X items in the user's cart.

    ![](https://developer.android.com/static/images/guide/playcore/engage/food-shopping-cart.png) **Figure:** Food Shopping Cart cluster from a single partner. (\*UI for illustrative purposes only)
- The **Food Shopping List** cluster shows a sneak peek of the grocery shopping
  lists from multiple developer partners in one UI grouping, prompting users to
  return to the corresponding app to update and complete their lists. There is a
  single Food Shopping List cluster.

  ![](https://developer.android.com/static/images/guide/playcore/engage/food-shopping-list.png) **Figure:** Food Shopping List cluster from a single partner. (\*UI for illustrative purposes only)
- The **Reorder** cluster shows a sneak peek of the previous orders from
  multiple developer partners in one UI grouping, prompting users to reorder.
  There is a single Reorder cluster.

  - Reorder cluster must show the total count of items in the
    user's previous order and must also include one of the following:

    - Images for X items in the user's previous order.
    - Labels for X items in the user's previous order.

  ![](https://developer.android.com/static/images/guide/playcore/engage/food-reorder-cluster.png) **Figure:** Food Reorder cluster from a single partner. (\*UI for illustrative purposes only)

### Pre-work

Minimum API level: 19

Add the `com.google.android.engage:engage-core` library to your app:

    dependencies {
        // Make sure you also include that repository in your project's build.gradle file.
        implementation 'com.google.android.engage:engage-core:1.6.0'
    }

### Summary

The design is based on an implementation of a [bound
service](https://developer.android.com/guide/components/bound-services).

The data a client can publish is subject to the following limits for different
cluster types:

| Cluster type | Cluster limits | Maximum entity limits in a cluster |
|---|---|---|
| Recommendation Cluster(s) | At most 7 | At most 50 (`ProductEntity`, `RecipeEntity`, or `StoreEntity`) |
| Featured Cluster | At most 1 | At most 20 (`ProductEntity`, `RecipeEntity`, or `StoreEntity`) |
| Food Shopping Cart Cluster | At most 1 | At most 3 `FoodShoppingCart` |
| Food Shopping List Cluster | At most 1 | At most 3 `FoodShoppingList` |
| Food Reorder Cluster | At most 1 | At most 1 `ReorderEntity` |

### Step 1: Provide entity data

The SDK has defined different entities to represent each item type. We support
the following entities for the Food category:

1. `ProductEntity`
2. `StoreEntity`
3. `RecipeEntity`
4. `FoodShoppingCart`
5. `FoodShoppingList`
6. `FoodReorderCluster`

The charts below outline available attributes and requirements for each type.

#### `ProductEntity`

The `ProductEntity` object represents an individual item (such as a grocery
item, dish from a restaurant, or a promotion) that developer partners want to
publish.

<br />

![](https://developer.android.com/static/images/guide/playcore/engage/food-product-entity.png) **Figure :** Attributes of `ProductEntity`

<br />

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Poster images | **Required** | At least one image must be provided. | See [Image Specifications](https://developer.android.com/guide/playcore/engage/food#image-specs) for guidance. |
| Action Uri | **Required** | The deep link to the page in the app displaying details about the product. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Title | Optional | The name of the product. | Free text **Recommended text size: under 90 chars** (Text that is too long may show ellipses) |
| Price - current | Conditionally required | The current price of the product. **Must be provided if strikethrough price is provided.** | Free text |
| Price - strikethrough | Optional | The original price of the entity, which is struck-through in the UI. | Free text |
| Callout | Optional | Callout to feature a promo, event, or update for the product, if available. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Callout fine print | Optional | Fine print text for the callout. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| **Rating (Optional) - Note: All ratings are displayed using our standard star rating system.** ||||
| Rating - Max value | Optional | The maximum value of the rating scale. **Must be provided if current value of rating is also provided.** | Number \>= 0.0 |
| Rating - Current value | Optional | The current value of the rating scale. **Must be provided if maximum value of rating is also provided.** | Number \>= 0.0 |
| Rating - Count | Optional | The count of the ratings for the product. **Note:** Provide this field if your app controls how the count is displayed to the users. Use a concise string. For example, if the count is 1,000,000, consider using an abbreviation like 1M so that the count isn't truncated on smaller display sizes. | String |
| Rating - Count Value | Optional | The count of the ratings for the product. **Note:** Provide this field if you don't handle the display abbreviation logic yourself. If both Count and Count Value are present, Count is displayed to users. | Long |
| **DisplayTimeWindow (Optional) - Set a time window for a content to be shown on the surface** ||||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |

#### `StoreEntity`

The `StoreEntity` object represents an individual store that developer partners
want to publish, such as a restaurant or a grocery store.

<br />

![](https://developer.android.com/static/images/guide/playcore/engage/food-store-entity.png) **Figure :** Attributes of `StoreEntity`

<br />

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Poster images | **Required** | At least one image must be provided. | See [Image Specifications](https://developer.android.com/guide/playcore/engage/food#image-specs) for guidance. |
| Action Uri | **Required** | The deep link to the page in the app displaying details about the store. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Title | Optional | The name of the store. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Location | Optional | The location of the store. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Callout | Optional | Callout to feature a promo, event, or update for the store, if available. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Callout fine print | Optional | Fine print text for the callout. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Description | Optional | A description of the store. | Free text **Recommended text size: under 90 chars** (Text that is too long may show ellipses) |
| Category | Optional | Category of a store, in the context of dining places, it can be cuisine like "french", "new american", "ramen", "fine dining". | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| **Note: All ratings is displayed using our standard star rating system.** ||||
| Rating - Max value | Optional | The maximum value of the rating scale. **Must be provided if current value of rating is also provided.** | Number \>= 0.0 |
| Rating - Current value | Optional | The current value of the rating scale. **Must be provided if maximum value of rating is also provided.** | Number \>= 0.0 |
| Rating - Count | Optional | The count of the ratings for the store. **Note:** Provide this field if your app wants to control how this is displayed to the users. Provide the concise string that can be displayed to the user. For example, if the count is 1,000,000, consider using abbreviations like 1M, so that it won't be truncated on smaller display sizes. | String |
| Rating - Count Value | Optional | The count of the ratings for the store. **Note:** Provide this field if you don't want to handle the display abbreviation logic yourself. If both Count and Count Value are present, we will use the Count to display to users | Long |

#### `RecipeEntity`

The `RecipeEntity` object represents a recipe item that developer partners want
to publish.

<br />

![](https://developer.android.com/static/images/guide/playcore/engage/food-recipe-entity.png) **Figure :** Attributes of `RecipeEntity`

<br />

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Poster images | **Required** | At least one image must be provided. | See [Image Specifications](https://developer.android.com/guide/playcore/engage/food#image-specs) for guidance. |
| Action Uri | **Required** | The deep link to the page in the app displaying details about the recipe. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Title | Optional | The name of the recipe. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Author | Optional | The author of the recipe. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Cook/Preparation time | Optional | The cooking time of the recipe. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Callout | Optional | Callout to feature a promo, event, or update for the recipe, if available. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Category | Optional | The category of the recipe. | Free text **Recommended text size: under 45 chars** (Text that is too long may show ellipses) |
| Description | Optional | A description of the recipe. | Free text **Recommended text size: under 90 chars** (Text that is too long may show ellipses) |
| **Note: All ratings are displayed using our standard star rating system.** ||||
| Rating - Max value | Optional | The maximum value of the rating scale. **Must be provided if current value of rating is also provided.** | Number \>= 0.0 |
| Rating - Current value | Optional | The current value of the rating scale. **Must be provided if maximum value of rating is also provided.** | Number \>= 0.0 |
| Rating - Count | Optional | The count of the ratings for the recipe. **Note:** Provide this field if your app wants to control how this is displayed to the users. Provide the concise string that can be displayed to the user. For example, if the count is 1,000,000, consider using abbreviations like 1M, so that it won't be truncated on smaller display sizes. | String |
| Rating - Count Value | Optional | The count of the ratings for the recipe. **Note:** Provide this field if you don't want to handle the display abbreviation logic yourself. If both Count and Count Value are present, we will use the Count to display to users | Long |

#### `FoodShoppingCart`

<br />

![](https://developer.android.com/static/images/guide/playcore/engage/food-shopping-cart-attributes.png) **Figure:** Food Shopping Cart cluster attributes.

<br />

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | The deep link to the shopping cart in the partner's app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Number of items | **Required** | The number of items (not just number of products) in the shopping cart. **For example: If there are 3 oranges and 1 apple in the cart, this number should be 4.** | Integer \>= 1 |
| Last user interaction timestamp | **Required** | Number of milliseconds elapsed from the epoch, identifying the last time when user interacted with the shopping cart. | Epoch timestamp in milliseconds |
| Title | Optional | The title of the cart (for example, *Your cart*). **If no title is provided by the developer, *Your cart* is the default.** | Free text **Recommended text size: under 25 chars** (Text that is too long may show ellipses) |
| Action Text | Optional | The call to action text of the button on the Shopping Cart (for example, *Your Shopping Bag*). **If no action text is provided by the developer, *View Cart* is the default.** This attribute is supported in version 1.1.0 onwards. | String |
| Cart images | Optional | Images of each product in the cart. **Up to 10 images can be provided in order of priority; the actual number of images displayed depends on the device form factor.** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/food#image-specs) for guidance. |
| Item labels | Optional | The list of labels for items on the shopping list. **The actual number of labels displayed depends on the device form factor.** | List of free text labels **Recommended text size: under 20 chars** (Text that is too long may show ellipses) |
| **DisplayTimeWindow (Optional) - Set a time window for a content to be shown on the surface** ||||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |

#### `FoodShoppingList`

<br />

![](https://developer.android.com/static/images/guide/playcore/engage/food-shopping-list.png) **Figure:** Food Shopping List cluster.

<br />

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | The deep link to the shopping list in the partner's app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Number of items | **Required** | The number of items in the shopping list. | Integer \>= 1 |
| Last user interaction timestamp | **Required** | Number of milliseconds elapsed from the epoch, identifying the last time when user interacted with the shopping list. | Epoch timestamp in milliseconds |
| Title | Optional | The title of the list (for example, *Your Grocery List*). **If no title is provided by the developer, *Shopping list* is the default.** | Free text **Recommended text size: under 25 chars** (Text that is too long may show ellipses) |
| Item labels | **Required** | The list of labels for items on the shopping list. **At least 1 label must be provided and up to 10 labels can be provided in order of priority; the actual number of labels displayed depends on the device form factor.** | List of free text labels **Recommended text size: under 20 chars** (Text that is too long may show ellipses) |

#### `FoodReorderCluster`

<br />

![](https://developer.android.com/static/images/guide/playcore/engage/food-reorder-cluster.png) **Figure:** Food Reorder cluster.

<br />

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | The deep link to reorder in the partner's app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Action Text | Optional | The call to action text of the button on the Reorder (for example, *Order again*). **If no action text is provided by the developer, *Reorder* is the default.** This attribute is supported in version 1.1.0 onwards. | String |
| Number of items | **Required** | The number of items (not just number of products) in the previous order. **For example: If there were 3 small coffees and 1 croissant in the previous order, this number should be 4.** | Integer \>= 1 |
| Title | **Required** | The title of the reorder item. | Free text **Recommended text size: under 40 chars** (Text that is too long may show ellipses) |
| Item labels | Optional (If not provided, poster images should be provided) | The list of item labels for the previous order. **Up to 10 labels can be provided in order of priority; the actual number of labels displayed depends on the device form factor.** | List of free text **Recommended text size per label: under 20 chars** (Text that is too long may show ellipses) |
| Poster images | Optional (If not provided, item labels should be provided) | Images of the items in the previous order. **Up to 10 images can be provided in order of priority; the actual number of images displayed depends on the device form factor.** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/food#image-specs) for guidance. |

#### Image specifications

Required specifications for image assets are listed below:

| Aspect ratio | Minimum pixels | Recommended pixels |
|---|---|---|
| Square (1x1) **Preferred** | 300x300 | 1200x1200 |
| Landscape (1.91x1) | 600x314 | 1200x628 |
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

`AppEngageFoodClient` is responsible for publishing food clusters.

There are following APIs to publish clusters in the client:

- `isServiceAvailable`
- `publishRecommendationClusters`
- `publishFeaturedCluster`
- `publishFoodShoppingCarts`
- `publishFoodShoppingLists`
- `publishReorderCluster`
- `publishUserAccountManagementRequest`
- `updatePublishStatus`
- `deleteRecommendationsClusters`
- `deleteFeaturedCluster`
- `deleteFoodShoppingCartCluster`
- `deleteFoodShoppingListCluster`
- `deleteReorderCluster`
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
| Food Reorder Cluster | `TYPE_FOOD_REORDER` | 5 |
| Food Shopping Cart Cluster | `TYPE_FOOD_SHOPPING_CART` | 6 |
| Food Shopping List Cluster | `TYPE_FOOD_SHOPPING_LIST` | 7 |
| User Management Cluster | `TYPE_ENGAGEMENT` | 8 |
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
any set of devices, all continuation cluster publications (e.g. Food Shopping
Cart, Food Shopping List, and Reorder) will be still enabled by default
configuration, and the rest of the cluster types will be enabled and disabled
intermittently. If intermittent ingestion applies to you but this default
configuration is not suitable for your needs, please contact
engage-developers@google.com.

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
| List of ProductEntity, StoreEntity, or RecipeEntity | **Required** | A list of entities that make up the recommendations for this Recommendation Cluster. Entities in a single cluster must be of the same type. |
| Title | **Required** | The title for the Recommendation Cluster (for example, *Big savings on Thanksgiving menu*). **Recommended text size: under 25 chars** (Text that is too long may show ellipses) |
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
                            .setTitle("Big savings on Thanksgiving menu")
                            .build())
                    .build())

### Java

    client.publishRecommendationClusters(
                new PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        new RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Big savings on Thanksgiving menu")
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

#### `publishFoodShoppingCarts`

This API is used to publish a list of `FoodShoppingCart` objects.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishFoodShoppingCarts(
                PublishFoodShoppingCartsRequest.Builder()
                    .addFoodShoppingCart(
                        FoodShoppingCart.Builder()
                            ...
                            .build())
                    .build())

### Java

    client.publishFoodShoppingCarts(
                new PublishFoodShoppingCartsRequest.Builder()
                    .addFoodShoppingCart(
                        new FoodShoppingCart.Builder()
                            ...
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `FoodShoppingCart` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Shopping Cart Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishFoodShoppingLists`

This API is used to publish a list of `FoodShoppingList` objects.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishFoodShoppingLists(
                PublishFoodShoppingListsRequest.Builder()
                    .addFoodShoppingList(
                        FoodShoppingListEntity.Builder()
                            ...
                            .build())
                    .build())

### Java

    client.publishFoodShoppingLists(
                new PublishFoodShoppingListsRequest.Builder()
                    .addFoodShoppingList(
                        new FoodShoppingListEntity.Builder()
                            ...
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `FoodShoppingList` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Shopping List Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishReorderCluster`

This API is used to publish a `FoodReorderCluster` object.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishReorderCluster(
                PublishReorderClusterRequest.Builder()
                    .setReorderCluster(
                        FoodReorderCluster.Builder()
                            ...
                            .build())
                    .build())

### Java

    client.publishReorderCluster(
                new PublishReorderClusterRequest.Builder()
                    .setReorderCluster(
                        new FoodReorderCluster.Builder()
                            ...
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `FoodReorderCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Reorder Cluster.

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

#### `deleteFoodShoppingCartCluster`

This API is used to delete the content of Food Shopping Cart Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteFoodShoppingCartCluster()

### Java

    client.deleteFoodShoppingCartCluster();

When the service receives the request, it removes the existing data from the
Food Shopping Cart Cluster. In case of an error, the entire request is rejected
and the existing state is maintained.

> [!NOTE]
> **Note:** This api is availaile from version 1.1.0 onwards.

#### `deleteFoodShoppingListCluster`

This API is used to delete the content of Food Shopping List Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteFoodShoppingListCluster()

### Java

    client.deleteFoodShoppingListCluster();

When the service receives the request, it removes the existing data from the
Food Shopping List Cluster. In case of an error, the entire request is rejected
and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteReorderCluster`

This API is used to delete the content of FoodReorderCluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteReorderCluster()

### Java

    client.deleteReorderCluster();

When the service receives the request, it removes the existing data from the
Reorder Cluster. In case of an error, the entire request is rejected
and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

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
      // Trigger food shopping cart cluster publish when PUBLISH_FOOD_SHOPPING_CART broadcast
      // is received
      // Trigger food shopping list cluster publish when PUBLISH_FOOD_SHOPPING_LIST broadcast
      // is received
      // Trigger reorder cluster publish when PUBLISH_REORDER_CLUSTER broadcast is
      // received
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

    // Register food Shopping Cart Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_FOOD_SHOPPING_CART),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register food Shopping List Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_FOOD_SHOPPING_LIST),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register Reorder Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_REORDER_CLUSTER),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)
    }

### Java

    class AppEngageBroadcastReceiver extends BroadcastReceiver {
    // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION broadcast
    // is received

    // Trigger featured cluster publish when PUBLISH_FEATURED broadcast is received

    // Trigger food shopping cart cluster publish when PUBLISH_FOOD_SHOPPING_CART broadcast is
    // received

    // Trigger food shopping list cluster publish when PUBLISH_FOOD_SHOPPING_LIST broadcast is
    // received

    // Trigger reorder cluster publish when PUBLISH_REORDER_CLUSTER broadcast is
    // received
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

    // Register food Shopping Cart Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.shopping.service.Intents.ACTION_PUBLISH_FOOD_SHOPPING_CART),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register food Shopping List Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.shopping.service.Intents.ACTION_PUBLISH_FOOD_SHOPPING_LIST),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register Reorder Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.shopping.service.Intents.ACTION_PUBLISH_REORDER_CLUSTER),
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
             <action android:name="com.google.android.engage.action.food.PUBLISH_FOOD_SHOPPING_CART" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.food.PUBLISH_FOOD_SHOPPING_LIST" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.food.PUBLISH_REORDER_CLUSTER" />
          </intent-filter>
       </receiver>
    </application>

The following [intents](https://developer.android.com/reference/android/content/Intent) will be sent by the
service:

- `com.google.android.engage.action.PUBLISH_RECOMMENDATION` It is recommended to start a `publishRecommendationClusters` call when receiving this intent.
- `com.google.android.engage.action.PUBLISH_FEATURED` It is recommended to start a `publishFeaturedCluster` call when receiving this intent.
- `com.google.android.engage.action.food.PUBLISH_FOOD_SHOPPING_CART` It is recommended to start a `publishFoodShoppingCarts` call when receiving this intent.
- `com.google.android.engage.action.food.PUBLISH_FOOD_SHOPPING_LIST` It is recommended to start a `publishFoodShoppingLists` call when receiving this intent.
- `com.google.android.engage.action.food.PUBLISH_REORDER_CLUSTER` It is recommended to start a `publishReorderCluster` call when receiving this intent.

## Integration workflow

For a step-by-step guide on verifying your integration after it is complete, see
[Engage developer integration workflow](https://developer.android.com/guide/playcore/engage/workflow).

## FAQs

See [Engage SDK Frequently Asked Questions](https://developer.android.com/guide/playcore/engage/faq) for
FAQs.

## Contact

Contact [`engage-developers@google.com`](mailto:engage-developers@google.com) if there are any questions during
the integration process. Our team will reply as soon as possible.

## Next steps

After completing this integration, your next steps are as follows:

- Send an email to [`engage-developers@google.com`](mailto:engage-developers@google.com) and attach your integrated APK that is ready for testing by Google.
- Google will perform a verification and review internally to make sure the integration works as expected. If changes are needed, Google will contact you with any necessary details.
- When testing is complete and no changes are needed, Google will contact you to notify you that you can start publishing the updated and integrated APK to the Play Store.
- After Google has confirmed that your updated APK has been published to the Play Store, your **Recommendation** , **Featured** , **Shopping Cart** , **Shopping List** , and **Reorder** clusters will be published and visible to users.