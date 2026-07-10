> [!IMPORTANT]
> **Important:** Engage SDK has superseded Media Home, which is now deprecated. If you have an existing Media Home integration, follow the instructions in these guides to migrate your content to Engage SDK, which allows your content to be published to more devices and form factors. Please contact [`engage-developers@google.com`](mailto:engage-developers@google.com) if you have any questions.

Boost app engagement by reaching your users where they are. Integrate Engage SDK
to deliver personalized recommendations and continuation content directly to
users across multiple on-device surfaces, like
**[Collections](https://android-developers.googleblog.com/2024/07/introducing-collections-powered-by-engage-sdk.html)** , **[Entertainment
Space](https://blog.google/products/android/entertainment-space/)** , and the Play Store. The integration adds
less than 50 KB (compressed) to the average APK and takes most apps about a
week of developer time. Learn more at our **[business
site](http://play.google.com/console/about/programs/EngageSDK)**.

This guide contains instructions for developer partners to deliver reading
content (eBooks, Audiobooks, Comics/Manga) to Engage content surfaces.

## Integration detail

### Terminology

This integration includes the following three cluster types: **Recommendation** ,
**Continuation** , and **Featured**.

- **Recommendation** clusters show personalized suggestions for content to read
  from an individual developer partner.

  Your recommendations take the following structure:
  - **Recommendation Cluster:** A UI view that contains a group of
    recommendations from a single developer partner.

    ![](https://developer.android.com/static/images/guide/playcore/engage/read-term-1.png) **Figure 1.** Entertainment Space UI showing a Recommendation Cluster from a single partner.
  - **Entity:** An object representing a single item in a cluster. An entity
    can be an ebook, an audio book, a book series, and more. See the [Provide
    entity data](https://developer.android.com/guide/playcore/engage/read#provide-entity-data) section for a list of supported entity
    types.

    ![](https://developer.android.com/static/images/guide/playcore/engage/read-term-2.png) **Figure 2.** Entertainment Space UI showing a single Entity within a single partner's Recommendation Cluster.
- The **Continuation** cluster shows unfinished books from multiple developer
  partners in a single UI grouping. Each developer partner will be allowed to
  broadcast a maximum of 10 entities in the Continuation cluster.

  ![](https://developer.android.com/static/images/guide/playcore/engage/read-term-3.png) **Figure 3.** Entertainment Space UI showing a Continuation cluster with unfinished recommendations from multiple partners (only one recommendation is currently visible).
- The **Featured** cluster showcases a selection of items from multiple
  developer partners in a single UI grouping. There will be a single Featured
  cluster, which is surfaced near the top of the UI with a priority placement
  above all Recommendation clusters. Each developer partner will be allowed to
  broadcast up to 10 entities in the Featured cluster.

  ![](https://developer.android.com/static/images/guide/playcore/engage/read-term-4.png) **Figure 4.** Entertainment Space UI showing a Featured cluster with recommendations from multiple partners (only one recommendation is currently visible).

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
| Recommendation Cluster(s) | At most 7 | At most 50 |
| Continuation Cluster | At most 1 | At most 20 |
| Featured Cluster | At most 1 | At most 20 |

### Step 1: Provide entity data

The SDK has defined different entities to represent each item type. We support
the following entities for the Read category:

1. `EbookEntity`
2. `AudiobookEntity`
3. `BookSeriesEntity`

The charts below outline available attributes and requirements for each type.

#### `EbookEntity`

The `EbookEntity` object represents an ebook (for example, the ebook of
*Becoming* by Michelle Obama).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/read#image-specs) for guidance. |
| Author | **Required** | At least one author name must be provided. |
| Action link uri | **Required** | The deep link to the provider app for the ebook. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Publish date | Optional | In epoch milliseconds if provided. |
| Description | Optional | Must be within 200 characters if provided. |
| Price | Optional | Free text |
| Page count | Optional | Must be a positive integer if provided. |
| Genre | Optional | List of genres associated with the book. |
| Series name | Optional | Name of the series that the ebook belongs to (for example, *Harry Potter*). |
| Series unit index | Optional | The index of the ebook in the series, where 1 is the first ebook in the series. For example, if *Harry Potter and the Prisoner of Azkaban* is the 3rd book in the series, this should be set to 3. |
| Continue book type | Optional | TYPE_CONTINUE - Resume on a unfinished book. TYPE_NEXT - Continue on a new one of a series. TYPE_NEW - Newly released. |
| Last Engagement Time | Conditionally required | Must be provided when the item is in the Continuation cluster. \*Newly\* acquired ebooks can be a part of the continue reading cluster. In epoch milliseconds. |
| Progress Percentage Complete | Conditionally required | Must be provided when the item is in the Continuation cluster. Value must be greater than 0 and less than 100. |
| **DisplayTimeWindow - Set a time window for a content to be shown on the surface** |||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. In epoch milliseconds. |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. In epoch milliseconds. |

#### `AudiobookEntity`

The `AudiobookEntity` object represents an audiobook (for example, the audiobook
of *Becoming* by Michelle Obama).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/read#image-specs) for guidance. |
| Author | **Required** | At least one author name must be provided. |
| Action link uri | **Required** | The deep link to the provider app for the audiobook. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Narrator | Optional | At least one narrator's name must be provided. |
| Publish date | Optional | In epoch milliseconds if provided. |
| Description | Optional | Must be within 200 characters if provided. |
| Price | Optional | Free text |
| Duration | Optional | Must be a positive value if provided. |
| Genre | Optional | List of genres associated with the book. |
| Series name | Optional | Name of the series that the audiobook belongs to (for example, *Harry Potter*. |
| Series unit index | Optional | The index of the audiobook in the series, where 1 is the first audiobook in the series. For example, if *Harry Potter and the Prisoner of Azkaban* is the 3rd book in the series, this should be set to 3. |
| Continue book type | Optional | TYPE_CONTINUE - Resume on a unfinished book. TYPE_NEXT - Continue on a new one of a series. TYPE_NEW - Newly released. |
| Last Engagement Time | Conditionally required | Must be provided when the item is in the Continuation cluster. In epoch milliseconds. |
| Progress Percentage Complete | Conditionally required | Must be provided when the item is in the Continuation cluster. \*Newly\* acquired audiobooks can be a part of the continue reading cluster. Value must be greater than 0 and less than 100. |
| **DisplayTimeWindow - Set a time window for a content to be shown on the surface** |||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. In epoch milliseconds. |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. In epoch milliseconds. |

#### `BookSeriesEntity`

The `BookSeriesEntity` object represents a book series (for example, the *Harry
Potter* book series, which has 7 books).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/read#image-specs) for guidance. |
| Author | **Required** | At least one author name must be present. |
| Action link uri | **Required** | The deep link to the provider app for the audiobook or ebook. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Book count | **Required** | Number of books in the series. |
| Description | Optional | Must be within 200 characters if provided. |
| Genre | Optional | List of genres associated with the book. |
| Continue book type | Optional | TYPE_CONTINUE - Resume on a unfinished book. TYPE_NEXT - Continue on a new one of a series. TYPE_NEW - Newly released. |
| Last Engagement Time | Conditionally required | Must be provided when the item is in the Continuation cluster. In epoch milliseconds. |
| Progress Percentage Complete | Conditionally required | Must be provided when the item is in the Continuation cluster. \*Newly\* acquired book series can be a part of the continue reading cluster. Value must be greater than 0 and less than 100. |
| **DisplayTimeWindow - Set a time window for a content to be shown on the surface** |||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. In epoch milliseconds. |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. In epoch milliseconds. |

#### Image specifications

Required specifications for image assets are listed below:

| Aspect ratio | Supported cluster(s) | Minimum pixels | Recommended pixels |
|---|---|---|---|
| Square (1x1) | All clusters | 300x300 | 1200x1200 |
| Landscape (1.91x1) | Featured and continuation | 600x314 | 1200x628 |
| Portrait (4x5) | Recommendation | 480x600 | 960x1200 |

*File formats*

PNG, JPG, static GIF, WebP

*Maximum file size*

5120 KB

*Additional recommendations*

- **Image safe area:** Put your important content in the center 80% of the image.

#### Example

    AudiobookEntity audiobookEntity =
            new AudiobookEntity.Builder()
                .setName("Becoming")
                .addPosterImage(
                          new Image.Builder()
                              .setImageUri(Uri.parse("http://www.x.com/image.png"))
                              .setImageHeightInPixel(960)
                              .setImageWidthInPixel(408)
                              .build())
                .addAuthor("Michelle Obama")
                .addNarrator("Michelle Obama")
                .setActionLinkUri(Uri.parse("https://play.google/audiobooks/1"))
                .setDurationMillis(16335L)
                .setPublishDateEpochMillis(1633032895L)
                .setDescription("An intimate, powerful, and inspiring memoir")
                .setPrice("$16.95")
                .addGenre("biography")
                .build();

### Step 2: Provide Cluster data

It's recommended to have the content publish job executed in the background
(for example, using [WorkManager](https://developer.android.com/topic/libraries/architecture/workmanager))
and scheduled on a regular basis or on an event basis (for example, every time
the user opens the app or when the user just added something to their cart).

`AppEngagePublishClient` is responsible for publishing clusters. Following
APIs are available in the client:

- `isServiceAvailable`
- `publishRecommendationClusters`
- `publishFeaturedCluster`
- `publishContinuationCluster`
- `publishUserAccountManagementRequest`
- `updatePublishStatus`
- `deleteRecommendationsClusters`
- `deleteFeaturedCluster`
- `deleteContinuationCluster`
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
            // The IPC call itself fails, proceed with error handling logic here such as retry.
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
any set of devices, all continuation cluster publications (e.g. Continue
Reading) will be still enabled by default
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

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishRecommendationClusters(
                PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Reconnect with yourself")
                            .build())
                    .build())

### Java

    client.publishRecommendationClusters(
                new PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        new RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Reconnect with yourself")
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `RecommendationCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Recommendation Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishFeaturedCluster`

This API is used to publish a list of `FeaturedCluster` objects.

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

#### `publishContinuationCluster`

This API is used to publish a `ContinuationCluster` object.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishContinuationCluster(
                PublishContinuationClusterRequest.Builder()
                    .setContinuationCluster(
                        ContinuationCluster.Builder()
                            .addEntity(book_entity1)
                            .addEntity(book_entity2)
                            .build())
                    .build())

### Java

    client.publishContinuationCluster(
                PublishContinuationClusterRequest.Builder()
                    .setContinuationCluster(
                        ContinuationCluster.Builder()
                            .addEntity(book_entity1)
                            .addEntity(book_entity2)
                            .build())
                    .build())

When the service receives the request, the following actions take place within
one transaction:

- Existing `ContinuationCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Continuation Cluster.

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

#### `deleteContinuationCluster`

This API is used to delete the content of Continuation Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteContinuationCluster()

### Java

    client.deleteContinuationCluster();

When the service receives the request, it removes the existing data from the
Continuation Cluster. In case of an error, the entire request is rejected
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
      // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION broadcast
      // is received
      // Trigger featured cluster publish when PUBLISH_FEATURED broadcast is received
      // Trigger continuation cluster publish when PUBLISH_CONTINUATION broadcast is
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

    // Register Continuation Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_CONTINUATION),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)
    }

### Java

    class AppEngageBroadcastReceiver extends BroadcastReceiver {
    // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION broadcast
    // is received

    // Trigger featured cluster publish when PUBLISH_FEATURED broadcast is received

    // Trigger continuation cluster publish when PUBLISH_CONTINUATION broadcast is
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

    // Register Continuation Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.service.Intents.ACTION_PUBLISH_CONTINUATION),
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
             <action android:name="com.google.android.engage.action.PUBLISH_CONTINUATION" />
          </intent-filter>
       </receiver>
    </application>

The following [intents](https://developer.android.com/reference/android/content/Intent) will be sent by the
service:

- `com.google.android.engage.action.PUBLISH_RECOMMENDATION` It is recommended to start a `publishRecommendationClusters` call when receiving this intent.
- `com.google.android.engage.action.PUBLISH_FEATURED` It is recommended to start a `publishFeaturedCluster` call when receiving this intent.
- com.google.android.engage.action.PUBLISH_CONTINUATION`It is recommended to start a`publishContinuationCluster\` call when receiving this intent.

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
- After Google has confirmed that your updated APK has been published to the Play Store, your **Recommendation** , **Featured** , and **Continuation** clusters will be published and visible to users.