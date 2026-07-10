Boost app engagement by reaching your users where they are. Integrate Engage SDK
to deliver personalized recommendations and continuation content directly to
users across multiple on-device surfaces, like
**[Collections](https://android-developers.googleblog.com/2024/07/introducing-collections-powered-by-engage-sdk.html)** , **[Entertainment
Space](https://blog.google/products/android/entertainment-space/)** , and the Play Store. The integration adds
less than 50 KB (compressed) to the average APK and takes most apps about a
week of developer time. Learn more at our **[business
site](http://play.google.com/console/about/programs/EngageSDK)**.

This guide contains instructions for developer partners to deliver social media
content to Engage content surfaces.

## Integration detail

The following section captures the integration detail.

### Terminology

***Recommendation*** clusters show personalized suggestions from an individual
developer partner.

Your recommendations take the following structure:

**Recommendation Cluster**: UI view that contains a group of recommendations
from the same developer partner.

Each Recommendation Cluster consists of one of the following two types of
entities :

- PortraitMediaEntity
- SocialPostEntity

**PortraitMediaEntity** must contain 1 portrait image for the post. Profile and
Interaction related metadata are optional.

- Post

  - Image in portrait mode and Timestamp, or
  - Image in portrait mode + text content and Timestamp
- Profile

  - Avatar, Name or Handle, Additional image
- Interactions

  - Count and label only, or
  - Count and visual (icon)

**SocialPostEntity** contains profile, post and interaction related metadata.

- Profile

  - Avatar, Name or Handle, additional text, additional image
- Post

  - Text and Timestamp, or
  - Rich media (image or rich URL) and Timestamp, or
  - Text and rich media (image or rich URL) and Timestamp, or
  - Video preview (thumbnail and duration) and Timestamp
- Interactions

  - Count \& label only, or
  - Count \& visual (icon)

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

| Cluster type | Cluster limits | Minimum entity limits in a cluster | Maximum entity limits in a cluster |
|---|---|---|---|
| Recommendation Cluster(s) | At most 7 | At least 1 (`PortraitMediaEntity`, or `SocialPostEntity`) | At most 50 (`PortraitMediaEntity`, or `SocialPostEntity`) |

### Step 1: Provide entity data

The SDK has defined different entities to represent each item type. The SDK
supports the following entities for the Social category:

1. `PortraitMediaEntity`
2. `SocialPostEntity`

The charts below outline available attributes and requirements for each type.

#### `PortraitMediaEntity`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action URI | **Required** for all surfaces other than Google TV | Deep Link to the entity in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | URI |
| PlatformSpecificPlayback | **Required** for Google TV surface | Deep Link to the entity in the provider app for platforms like Google TV and Mobile. | List of PlatformSpecificPlayback objects |
| Recommendation Reason | Optional | The justification for recommending the content to the user. | RecommendationReason object |
| Comments Summary | Optional | Summary of comments for the post. | String |
| **Post related metadata (Required)** ||||
| Image(s) | Required | Image(s) should be in **portrait aspect ratio.** The UI may show only 1 image when multiple images are provided. However, the UI may provide visual indication that there are more images in the app. *If the post is a video, the provider should provide a thumbnail of the video to be shown as an image.* | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| Text content | Optional | The main text of a post, update, etc. | String (recommended max 140 chars) |
| Timestamp | Optional | Time when the post was published. | Epoch timestamp in milliseconds |
| Is video content | Optional | Is the post a video? | boolean |
| Video duration | Optional | The duration of the video in milliseconds. | Long |
| **Profile related metadata (Optional)** ||||
| Name | Required | Profile name or id or handle, eg "John Doe", "@TeamPixel" | String(recommended max 25 chars) |
| Avatar | Required | Profile picture or avatar image of the user. **Square 1:1 image** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| Additional Image | Optional | Profile badge. for example - verified badge **Square 1:1 image** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| **Interactions related metadata (Optional)** ||||
| Count | Optional | Indicate the number of interactions, for example - "3.7 M.". **Note:** If both Count and Count Value are provided, Count will be used. **Note:** Partners should use either **Count** or **CountWithOptionalLabel**. | String |
| CountWithOptionalLabel | Optional | Indicate the number of interactions with an optional label, for example - "3.7 M Likes.". **Note:** If both CountWithOptionalLabel and Count Value are provided, one of them will be used. **Note:** Partners should use either **Count** or **CountWithOptionalLabel**. | String |
| Count Value | Optional | The number of interactions as a value. **Note:** Provide Count Value instead of Count if your app doesn't handle logic on how a large number should be optimized for different display sizes. If both Count and Count Value are provided, Count is used. | Long |
| Label | Optional | Indicate what the interaction label is for. For example - "Likes". | String |
| Visual | Optional | Indicate what the interaction is for. For example - Image showing Likes icon, emoji. Can provide more than 1 image, though not all may not be shown on all form factors. **Note:** Must be Square 1:1 image | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| **DisplayTimeWindow (Optional) - Set a time window for a content to be shown on the surface** ||||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |

#### `SocialPostEntity`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action URI | **Required** | Deep Link to the entity in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | URI |
| PlatformSpecificPlayback URIs | **Required** for Google TV surface | Deep Link to the entity in the provider app for platforms like Google TV and Mobile. | List of PlatformSpecificPlayback objects |
| Recommendation Reason | Optional | The justification for recommending the content to the user. | RecommendationReason object |
| Comments Summary | Optional | Summary of comments for the post. | String |
| **Post related metadata (Required)** At least one of TextContent, Image or WebContent is required ||||
| Image(s) | Optional | Image(s) should be in **portrait aspect ratio.** The UI may show only 1 image when multiple images are provided. However, the UI may provide visual indication that there are more images in the app. *If the post is a video, the provider should provide a thumbnail of the video to be shown as an image.* | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| Text content | Optional | The main text of a post, update, etc. | String (recommended max 140 chars) |
| **Video Content (Optional)** ||||
| Duration | Required | The duration of the video in milliseconds. | Long |
| Image | Required | Preview image of the video content. | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| **Link Preview (Optional)** ||||
| Link Preview - Title | Required | Text to indicate the title of the web page content | String |
| Link Preview - Hostname | Required | Text to indicate the web page owner, eg "INSIDER" | String |
| Link Preview - Image | Optional | Hero image for the web content | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| Timestamp | Optional | Time when the post was published. | Epoch timestamp in milliseconds |
| **Profile related metadata (Optional)** ||||
| Name | Required | Profile name or id or handle, eg "John Doe", "@TeamPixel." | String(recommended max 25 chars) |
| Additional Text | Optional | Could be used as profile id or handle or additional metadata For example "@John-Doe", "5M followers", "You might like", "Trending", "5 new posts" | String(recommended max 40 chars) |
| Avatar | Required | Profile picture or avatar image of the user. **Square 1:1 image** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| Additional Image | Optional | Profile badge, for example - verified badge **Square 1:1 image** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| **Interactions related metadata (Optional)** ||||
| Count | Required | Indicate the number of interactions, for example - "3.7 M." **Note:** Partners should use either **Count** or **CountWithOptionalLabel**. | String |
| CountWithOptionalLabel | Required | Indicate the number of interactions with an optional label, for example - "3.7 M Likes." **Note:** Partners should use either **Count** or **CountWithOptionalLabel**. | String |
| Label | Optional If not provided, **Visual** must be provided. | Indicate what the interaction is for. For example - "Likes." | String (recommended max 20 chars for count + label combined) |
| Visual | Optional If not provided, **Label** must be provided. | Indicate what the interaction is for. For example - Image showing Likes icon, emoji. Can provide more than 1 image, though not all may not be shown on all form factors. **Square 1:1 image** | See [Image Specifications](https://developer.android.com/guide/playcore/engage/social#image-specs) for guidance. |
| **DisplayTimeWindow (Optional) - Set a time window for a content to be shown on the surface** ||||
| Start Timestamp | Optional | The epoch timestamp after which the content should be shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |
| End Timestamp | Optional | The epoch timestamp after which the content is no longer shown on the surface. If not set, content is eligible to be shown on the surface. | Epoch timestamp in milliseconds |

#### Image specifications

The images are required to be hosted on public CDNs so that Google can access
them.

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
the user opens the app or when the user just followed a new account)

`AppEngageSocialClient` is responsible for publishing social clusters.

There are following APIs to publish clusters in the client:

- `isServiceAvailable`
- `publishRecommendationClusters`
- `publishUserAccountManagementRequest`
- `updatePublishStatus`
- `deleteRecommendationsClusters`
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
cluster types. If you are interested in opting into this feature for any cluster type,
please contact engage-developers@google.com.

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

This API is used to publish a list `RecommendationCluster` objects.

A `RecommendationCluster` object can have the following attributes:

| Attribute | Requirement | Description |
|---|---|---|
| List of SocialPostEntity, or PortraitMediaEntity | **Required** | A list of entities that make up the recommendations for this Recommendation Cluster. Entities in a single cluster must be of the same type. |
| Title | **Required** | The title for the Recommendation Cluster (for example, *Latest from your friends*). **Recommended text size: under 25 chars** (Text that is too long may show ellipses) |
| Subtitle | Optional | The subtitle for the Recommendation Cluster. |
| Action Uri | Optional | The deep link to the page in the partner app where users can see the complete list of recommendations. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

> [!IMPORTANT]
> **Important:** For social apps, it's critical to update recommendations after each app usage. Social app users are more interested in the most recent recommendations and ideally would like to see a post at most once.

### Kotlin

    client.publishRecommendationClusters(
                PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Latest from your friends")
                            .build())
                    .build())

### Java

    client.publishRecommendationClusters(
                new PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        new RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Latest from your friends")
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- All existing Recommendation Cluster data is removed.
- Data from the request is parsed and stored in new Recommendation Clusters.

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

#### `deleteClusters`

This API is used to delete the content of a given cluster type.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteClusters(
        DeleteClustersRequest.Builder()
          .addClusterType(ClusterType.TYPE_RECOMMENDATION)
          ...
          .build())

### Java

    client.deleteClusters(
                new DeleteClustersRequest.Builder()
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
    }

    fun registerBroadcastReceivers(context: Context){
      var  context = context
      context = context.applicationContext

    // Register Recommendation Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_RECOMMENDATION),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)
    }

### Java

    class AppEngageBroadcastReceiver extends BroadcastReceiver {
    // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION broadcast
    // is received
    }

    public static void registerBroadcastReceivers(Context context) {

    context = context.getApplicationContext();

    // Register Recommendation Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.service.Intents.ACTION_PUBLISH_RECOMMENDATION),
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
       </receiver>
    </application>

The following [intents](https://developer.android.com/reference/android/content/Intent) will be sent by the
service:

- `com.google.android.engage.action.PUBLISH_RECOMMENDATION` It is recommended to start a `publishRecommendationClusters` call when receiving this intent.

## Integration workflow

For a step-by-step guide on verifying your integration after it is complete, see
[Engage developer integration workflow](https://developer.android.com/guide/playcore/engage/workflow).

## FAQs

See [Engage SDK Frequently Asked Questions](https://developer.android.com/guide/playcore/engage/faq) for
FAQs.

## Contact

Contact
[`engage-developers@google.com`](mailto:engage-developers@google.com) if there are
any questions during the integration process. Our team will reply as soon as
possible.

## Next steps

After completing this integration, your next steps are as follows:

- Send an email to [`engage-developers@google.com`](mailto:engage-developers@google.com) and attach your integrated APK that is ready for testing by Google.
- Google performs a verification and reviews internally to make sure the integration works as expected. If changes are needed, Google contacts you with any necessary details.
- When testing is complete and no changes are needed, Google contacts you to notify you that you can start publishing the updated and integrated APK to the Play Store.
- After Google has confirmed that your updated APK has been published to the Play Store, your **Recommendation**, clusters will be published and visible to users.