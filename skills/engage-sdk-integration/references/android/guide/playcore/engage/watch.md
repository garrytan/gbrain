> [!IMPORTANT]
> **Important:** Engage SDK has superseded Media Home, which is now deprecated. If you have an existing Media Home integration, follow the instructions in these guides to migrate your content to Engage SDK, which allows your content to be published to more devices and form factors. Please contact [`engage-developers@google.com`](mailto:engage-developers@google.com) if you have any questions.

Boost app engagement by reaching your users where they are. Integrate Engage
SDK to deliver Continue Watching content and personalized recommendations
directly to users across multiple on-device surfaces
**[Collections](https://android-developers.googleblog.com/2024/07/introducing-collections-powered-by-engage-sdk.html)** ,
**[Entertainment Space](https://blog.google/products/android/entertainment-space/)** , and the Play Store. The
integration adds less than 50 KB (compressed) to the average APK and takes
most apps about a week of developer time. Learn more at our
**[business site](http://play.google.com/console/about/programs/EngageSDK)**.

This guide contains instructions for developer partners to integrate their video
content, using the Engage SDK to populate both this new surface area and
existing Google surfaces.

> [!NOTE]
> **Note:** Check the [TV integration guide](https://developer.android.com/guide/playcore/engage/tv) to learn more about the Continue Watching experience on Google TV.

## Integration detail

### Terminology

This integration includes the following three cluster types: **Recommendation** ,
**Continuation** , and **Featured**.

- **Recommendation** clusters show personalized suggestions for content to watch
  from an individual developer partner.

  Your recommendations take the following structure:
  - **Recommendation Cluster:** A UI view that contains a group of
    recommendations from the same developer partner.

    ![](https://developer.android.com/static/images/guide/playcore/engage/watch-term-1.png) **Figure 1.** Entertainment Space UI showing a Recommendation Cluster from a single partner.
  - **Entity:** An object representing a single item in a cluster. An entity
    can be a movie, a TV show, a TV series, live video, and more. See the
    [Provide entity data](https://developer.android.com/guide/playcore/engage/watch#provide-entity-data) section for a list of
    supported entity types.

    ![](https://developer.android.com/static/images/guide/playcore/engage/watch-term-2.png) **Figure 2.** Entertainment Space UI showing a single Entity within a single partner's Recommendation Cluster.
- The **Continuation** cluster shows unfinished videos and relevant newly
  released episodes from multiple developer partners in one UI grouping. Each
  developer partner will be allowed to broadcast a maximum of 10 entities in the
  Continuation cluster. Research has shown that personalized recommendations
  along with personalized Continuation content creates the best user engagement.

  ![](https://developer.android.com/static/images/guide/playcore/engage/watch-term-3.png) **Figure 3.** Entertainment Space UI showing a Continuation cluster with unfinished recommendations from multiple partners (only one recommendation is currently visible).
- The **Featured** cluster showcases a selection of entities from multiple
  developer partners in one UI grouping. There will be a single Featured
  cluster, which is surfaced near the top of the UI with a priority placement
  above all Recommendation clusters. Each developer partner will be allowed to
  broadcast up to 10 entities in the Featured cluster.

  ![](https://developer.android.com/static/images/guide/playcore/engage/watch-term-4.png) **Figure 4.** Entertainment Space UI showing a Featured cluster with recommendations from multiple partners (only one recommendation is currently visible).

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
| Recommendation Cluster(s) | At most 7 | At most 50 |
| Continuation Cluster | At most 1 | At most 20 |
| Featured Cluster | At most 1 | At most 20 |

> [!IMPORTANT]
> **Important:** Engage SDK has superseded Media Home, which is now deprecated. If you have an existing Media Home integration, follow the instructions in [Step
> 0](https://developer.android.com/guide/playcore/engage/watch#migration) to migrate your content to Engage SDK, which allows your content to be published to more devices and form factors. Contact [`engage-developers@google.com`](mailto:engage-developers@google.com). If you don't have an existing Media Home integration, skip to [Step
> 1](https://developer.android.com/guide/playcore/engage/watch#provide-entity-data).

### Step 0: Migration from existing Media Home SDK integration

#### Map data models from existing integration

If you are migrating from an existing Media Home integration, the following
table outlines how to map data models in existing SDKs to the new Engage SDK:

| MediaHomeVideoContract integration equivalent | Engage SDK integration equivalent |
|---|---|
| `com.google.android.mediahome.video.PreviewChannel` | ` com.google.android.engage.common.datamodel.RecommendationCluster ` |
| `com.google.android.mediahome.video.PreviewChannel.Builder` | ` com.google.android.engage.common.datamodel.RecommendationCluster.Builder ` |
| `com.google.android.mediahome.video.PreviewChannelHelper` | `com.google.android.engage.video.service.AppEngageVideoClient` |
| `com.google.android.mediahome.video.PreviewProgram` | Divided into separate classes: `EventVideo`, `LiveStreamingVideo`, `Movie`, `TvEpisode`, `TvSeason`, `TvShow`, `VideoClipEntity` |
| `com.google.android.mediahome.video.PreviewProgram.Builder` | Divided into builders in separate classes: `EventVideo`, `LiveStreamingVideo`, `Movie`, `TvEpisode`, `TvSeason`, `TvShow`, `VideoClipEntity` |
| `com.google.android.mediahome.video.VideoContract` | No longer needed. |
| `com.google.android.mediahome.video.WatchNextProgram` | Divided into attributes in separate classes: `EventVideoEntity`, `LiveStreamingVideoEntity`, `MovieEntity`, `TvEpisodeEntity`, `TvSeasonEntity`, `TvShowEntity`, `VideoClipEntity` |
| `com.google.android.mediahome.video.WatchNextProgram.Builder` | Divided into attributes in separate classes: `EventVideoEntity`, `LiveStreamingVideoEntity`, `MovieEntity`, `TvEpisodeEntity`, `TvSeasonEntity`, `TvShowEntity`, `VideoClipEntity` |

#### Publishing clusters in Media Home SDK vs Engage SDK

With Media Home SDK, clusters and entities were published through separate APIs:

    // 1. Fetch existing channels
    List<PreviewChannel> channels = PreviewChannelHelper.getAllChannels();

    // 2. If there are no channels, publish new channels
    long channelId = PreviewChannelHelper.publishChannel(builder.build());

    // 3. If there are existing channels, decide whether to update channel contents
    PreviewChannelHelper.updatePreviewChannel(channelId, builder.build());

    // 4. Delete all programs in the channel
    PreviewChannelHelper.deleteAllPreviewProgramsByChannelId(channelId);

    // 5. publish new programs in the channel
    PreviewChannelHelper.publishPreviewProgram(builder.build());

With Engage SDK, cluster and entity publishing are combined into a single API
call. All entities that belong to a cluster are published together with that
cluster:

### Kotlin

    RecommendationCluster.Builder()
                .addEntity(MOVIE_ENTITY)
                .addEntity(MOVIE_ENTITY)
                .addEntity(MOVIE_ENTITY)
                .setTitle("Top Picks For You")
                .build()

### Java

    new RecommendationCluster.Builder()
                            .addEntity(MOVIE_ENTITY)
                            .addEntity(MOVIE_ENTITY)
                            .addEntity(MOVIE_ENTITY)
                            .setTitle("Top Picks For You")
                            .build();

### Step 1: Provide entity data

The SDK has defined different entities to represent each item type. We support
the following entities for the Watch category:

1. [`MovieEntity`](https://developer.android.com/guide/playcore/engage/watch#movieentity)
2. [`TvShowEntity`](https://developer.android.com/guide/playcore/engage/watch#tvshowentity)
3. [`TvSeasonEntity`](https://developer.android.com/guide/playcore/engage/watch#tvseasonentity)
4. [`TvEpisodeEntity`](https://developer.android.com/guide/playcore/engage/watch#tvepisodeentity)
5. [`LiveStreamingVideoEntity`](https://developer.android.com/guide/playcore/engage/watch#livestreamingvideoentity)
6. [`VideoClipEntity`](https://developer.android.com/guide/playcore/engage/watch#videoclipentity)

The following chart outlines attributes and requirements for each type.

#### `MovieEntity`

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image is required, and must be provided with an aspect ratio. (Landscape is preferred but passing both portrait and landscape images for different scenarios is recommended.) See [Image Specifications](https://developer.android.com/guide/playcore/engage/watch#image-specs) for guidance. |
| Playback uri | **Required** | The deep link to the provider app to start playing the movie. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Info page uri | Optional | The deep link to the provider app to show details about the movie. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Release date | Optional | In epoch milliseconds. |
| Availability | **Required** | AVAILABLE: The content is available to the user without any further action. FREE_WITH_SUBSCRIPTION: The content is available after the user purchases a subscription. PAID_CONTENT: The content requires user purchase or rental. PURCHASED: The content has been purchased or rented by the user. |
| Offer price | Optional | Free text |
| Duration | **Required** | In milliseconds. |
| Genre | **Required** | Free text |
| Content ratings | Optional | Free text, follow the industry standard. ([Example](https://www.spectrum.net/support/tv/tv-and-movie-ratings-descriptions)) |
| Call to action text | Optional | Free text to be displayed as a call to action. |
| Tags | Optional | List of tags associated with the entity. |
| Watch next type | Conditionally required | Must be provided when the item is in the Continuation cluster and must be one of the following four types: CONTINUE: The user has already watched more than 1 minute of this content. NEW: The user has watched all available episodes from some episodic content, but a new episode has become available and there is exactly one unwatched episode. This works for TV shows, recorded soccer matches in a series, and so on. NEXT: The user has watched one or more complete episodes from some episodic content, but there remains either more than one episode remaining or exactly one episode remaining where the last episode is not "NEW" and was released before the user started watching the episodic content. WATCHLIST: The user has explicitly elected to add a movie, event, or series to a watchlist to manually curate what they want to watch next. |
| Last engagement time | Conditionally required | Must be provided when the item is in the Continuation cluster. In epoch milliseconds. |
| Last playback position time | Conditionally required | Must be provided when the item is in the Continuation cluster and WatchNextType is CONTINUE. In epoch milliseconds. |

#### `TvShowEntity`

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image is required, and must be provided with an aspect ratio. (Landscape is preferred but passing both portrait and landscape images for different scenarios is recommended.) See [Image Specifications](https://developer.android.com/guide/playcore/engage/watch#image-specs) for guidance. |
| Info page uri | **Required** | The deep link to the provider app to show the details of the TV show. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Playback uri | Optional | The deep link to the provider app to start playing the TV show. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| First episode air date | Optional | In epoch milliseconds. |
| Latest episode air date | Optional | In epoch milliseconds. |
| Availability | **Required** | AVAILABLE: The content is available to the user without any further action. FREE_WITH_SUBSCRIPTION: The content is available after the user purchases a subscription. PAID_CONTENT: The content requires user purchase or rental. PURCHASED: The content has been purchased or rented by the user. |
| Offer price | Optional | Free text |
| Season count | **Required** | Positive integer |
| Genre | **Required** | Free text |
| Content ratings | Optional | Free text, follow the industry standard. ([Example](https://www.spectrum.net/support/tv/tv-and-movie-ratings-descriptions)) |
| Call to action text | Optional | Free text to be displayed as a call to action. |
| Tags | Optional | List of tags associated with the entity. |
| Watch next type | Conditionally required | Must be provided when the item is in the Continuation cluster and must be one of the following four types: CONTINUE: The user has already watched more than 1 minute of this content. NEW: The user has watched all available episodes from some episodic content, but a new episode has become available and there is exactly one unwatched episode. This works for TV shows, recorded soccer matches in a series, and so on. NEXT: The user has watched one or more complete episodes from some episodic content, but there remains either more than one episode remaining or exactly one episode remaining where the last episode is not "NEW" and was released before the user started watching the episodic content. WATCHLIST: The user has explicitly elected to add a movie, event, or series to a watchlist to manually curate what they want to watch next. |
| Last engagement time | Conditionally required | Must be provided when the item is in the Continuation cluster. In epoch milliseconds. |
| Last playback position time | Conditionally required | Must be provided when the item is in the Continuation cluster and WatchNextType is CONTINUE. In epoch milliseconds. |

#### `TvSeasonEntity`

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image is required, and must be provided with an aspect ratio. (Landscape is preferred but passing both portrait and landscape images for different scenarios is recommended.) See [Image Specifications](https://developer.android.com/guide/playcore/engage/watch#image-specs) for guidance. |
| Info page uri | **Required** | The deep link to the provider app to show the details of the TV show season. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Playback uri | Optional | The deep link to the provider app to start playing the TV show season. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Display Season number | **Optional** **Available in v1.3.1** | String |
| First episode air date | Optional | In epoch milliseconds. |
| Latest episode air date | Optional | In epoch milliseconds. |
| Availability | **Required** | AVAILABLE: The content is available to the user without any further action. FREE_WITH_SUBSCRIPTION: The content is available after the user purchases a subscription. PAID_CONTENT: The content requires user purchase or rental. PURCHASED: The content has been purchased or rented by the user. |
| Offer price | Optional | Free text |
| Episode count | **Required** | Positive integer |
| Genre | **Required** | Free text |
| Content ratings | Optional | Free text, follow the industry standard. ([Example](https://www.spectrum.net/support/tv/tv-and-movie-ratings-descriptions)) |
| Call to action text | Optional | Free text to be displayed as a call to action. |
| Tags | Optional | List of tags associated with the entity. |
| Watch next type | Conditionally required | Must be provided when the item is in the Continuation cluster and must be one of the following four types: CONTINUE: The user has already watched more than 1 minute of this content. NEW: The user has watched all available episodes from some episodic content, but a new episode has become available and there is exactly one unwatched episode. This works for TV shows, recorded soccer matches in a series, and so on. NEXT: The user has watched one or more complete episodes from some episodic content, but there remains either more than one episode remaining or exactly one episode remaining where the last episode is not "NEW" and was released before the user started watching the episodic content. WATCHLIST: The user has explicitly elected to add a movie, event, or series to a watchlist to manually curate what they want to watch next. |
| Last engagement time | Conditionally required | Must be provided when the item is in the Continuation cluster. In epoch milliseconds. |
| Last playback position time | Conditionally required | Must be provided when the item is in the Continuation cluster and WatchNextType is CONTINUE. In epoch milliseconds. |

#### `TvEpisodeEntity`

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image is required, and must be provided with an aspect ratio. (Landscape is preferred but passing both portrait and landscape images for different scenarios is recommended.) See [Image Specifications](https://developer.android.com/guide/playcore/engage/watch#image-specs) for guidance. |
| Playback uri | **Required** | The deep link to the provider app to start playing the episode. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Info page uri | Optional | The deep link to the provider app to show details about the TV show episode. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Display Episode number | **Optional** **Available in v1.3.1** | String |
| Air date | **Required** | In epoch milliseconds. |
| Availability | **Required** | AVAILABLE: The content is available to the user without any further action. FREE_WITH_SUBSCRIPTION: The content is available after the user purchases a subscription. PAID_CONTENT: The content requires user purchase or rental. PURCHASED: The content has been purchased or rented by the user. |
| Offer price | Optional | Free text |
| Duration | **Required** | Must be a positive value in milliseconds. |
| Genre | **Required** | Free text |
| Content ratings | Optional | Free text, follow the industry standard. ([Example](https://www.spectrum.net/support/tv/tv-and-movie-ratings-descriptions)) |
| Call to action text | Optional | Free text to be displayed as a call to action. |
| Tags | Optional | List of tags associated with the entity. |
| Watch next type | Conditionally required | Must be provided when the item is in the Continuation cluster and must be one of the following four types: CONTINUE: The user has already watched more than 1 minute of this content. NEW: The user has watched all available episodes from some episodic content, but a new episode has become available and there is exactly one unwatched episode. This works for TV shows, recorded soccer matches in a series, and so on. NEXT: The user has watched one or more complete episodes from some episodic content, but there remains either more than one episode remaining or exactly one episode remaining where the last episode is not "NEW" and was released before the user started watching the episodic content. WATCHLIST: The user has explicitly elected to add a movie, event, or series to a watchlist to manually curate what they want to watch next. |
| Last engagement time | Conditionally required | Must be provided when the item is in the Continuation cluster. In epoch milliseconds. |
| Last playback position time | Conditionally required | Must be provided when the item is in the Continuation cluster and WatchNextType is CONTINUE. In epoch milliseconds. |

#### `LiveStreamingVideoEntity`

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image is required, and must be provided with an aspect ratio. (Landscape is preferred but passing both portrait and landscape images for different scenarios is recommended.) See [Image Specifications](https://developer.android.com/guide/playcore/engage/watch#image-specs) for guidance. |
| Playback uri | **Required** | The deep link to the provider app to start playing the video. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Broadcaster | **Required** | Free text |
| Start time | Optional | In epoch milliseconds. |
| End time | Optional | In epoch milliseconds. |
| View count | Optional | Free text, must be localized. |
| Call to action text | Optional | Free text to be displayed as a call to action. |
| Tags | Optional | List of tags associated with the entity. |
| Watch next type | Conditionally required | Must be provided when the item is in the Continuation cluster and must be one of the following four types: CONTINUE: The user has already watched more than 1 minute of this content. NEW: The user has watched all available episodes from some episodic content, but a new episode has become available and there is exactly one unwatched episode. This works for TV shows, recorded soccer matches in a series, and so on. NEXT: The user has watched one or more complete episodes from some episodic content, but there remains either more than one episode remaining or exactly one episode remaining where the last episode is not "NEW" and was released before the user started watching the episodic content. WATCHLIST: The user has explicitly elected to add a movie, event, or series to a watchlist to manually curate what they want to watch next. |
| Last engagement time | Conditionally required | Must be provided when the item is in the Continuation cluster. In epoch milliseconds. |
| Last playback position time | Conditionally required | Must be provided when the item is in the Continuation cluster and WatchNextType is CONTINUE. In epoch milliseconds. |

#### `VideoClipEntity`

The `VideoClipEntity` object represents a video entity coming from social media,
such as TikTok or YouTube.

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image is required, and must be provided with an aspect ratio. (Landscape is preferred but passing both portrait and landscape images for different scenarios is recommended.) See [Image Specifications](https://developer.android.com/guide/playcore/engage/watch#image-specs) for guidance. |
| Playback uri | **Required** | The deep link to the provider app to start playing the video. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Created time | **Required** | In epoch milliseconds. |
| Duration | **Required** | Must be a positive value in milliseconds. |
| Creator | **Required** | Free text |
| Creator image | Optional | Image of the Creator avatar |
| View count | Optional | Free text, must be localized. |
| Call to action text | Optional | Free text to be displayed as a call to action. |
| Tags | Optional | List of tags associated with the entity. |
| Watch next type | Conditionally required | Must be provided when the item is in the Continuation cluster and must be one of the following four types: CONTINUE: The user has already watched more than 1 minute of this content. NEW: The user has watched all available episodes from some episodic content, but a new episode has become available and there is exactly one unwatched episode. This works for TV shows, recorded soccer matches in a series, and so on. NEXT: The user has watched one or more complete episodes from some episodic content, but there remains either more than one episode remaining or exactly one episode remaining where the last episode is not "NEW" and was released before the user started watching the episodic content. WATCHLIST: The user has explicitly elected to add a movie, event, or series to a watchlist to manually curate what they want to watch next. |
| Last engagement time | Conditionally required | Must be provided when the item is in the Continuation cluster. In epoch milliseconds. |
| Last playback position time | Conditionally required | Must be provided when the item is in the Continuation cluster and WatchNextType is CONTINUE. In epoch milliseconds. |

#### Image specifications

The following section lists the required specifications for image assets:

*File formats*

PNG, JPG, static GIF, WebP

*Maximum file size*

5120 KB

*Additional recommendations*

- **Image safe area:** Put your important content in the center 80% of the image.

#### Example

### Kotlin

    var movie = MovieEntity.Builder()
        .setName("Avengers")
        .addPosterImage(Image.Builder()
                              .setImageUri(Uri.parse("http://www.x.com/image.png"))
                              .setImageHeightInPixel(960)
                              .setImageWidthInPixel(408)
                              .build())
        .setPlayBackUri(Uri.parse("http://tv.com/playback/1"))
        .setReleaseDateEpochMillis(1633032895L)
        .setAvailability(ContentAvailability.AVAILABILITY_AVAILABLE)
        .setDurationMillis(12345678L)
        .addGenre("action")
        .addContentRating("R")
        .setWatchNextType(WatchNextType.TYPE_NEW)
        .setLastEngagementTimeMillis(1664568895L)
        .setCallToActionText("Watch Now")
        .addTag("Action")
        .build()

### Java

    MovieEntity movie = new MovieEntity.Builder()
                      .setName("Avengers")
                      .addPosterImage(
                          new Image.Builder()
                              .setImageUri(Uri.parse("http://www.x.com/image.png"))
                              .setImageHeightInPixel(960)
                              .setImageWidthInPixel(408)
                              .build())
                      .setPlayBackUri(Uri.parse("http://tv.com/playback/1"))
                      .setReleaseDateEpochMillis(1633032895L)
                      .setAvailability(ContentAvailability.AVAILABILITY_AVAILABLE)
                      .setDurationMillis(12345678L)
                      .addGenre("action")
                      .addContentRating("R")
                      .setWatchNextType(WatchNextType.TYPE_NEW)
                      .setLastEngagementTimeMillis(1664568895L)
                      .setCallToActionText("Watch Now")
                      .addTag("Action")
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
any set of devices, all continuation cluster publications (e.g. Continue
Watching) will be still enabled by default configuration, and the rest of the
cluster types will be enabled and disabled intermittently. If intermittent
ingestion applies to you but this default configuration is not suitable for
your needs, please contact engage-developers@google.com.

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
                .setTitle("Top Picks For You")
                .build()
            )
            .build()
        )

### Java

    client.publishRecommendationClusters(
                new PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        new RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Top Picks For You")
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
              .addEntity(entity1)
              .addEntity(entity2)
              .build())
          .build())

### Java

    client.publishFeaturedCluster(
                new PublishFeaturedClustersRequest.Builder()
                    .addFeaturedCluster(
                        new FeaturedCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
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
              .addEntity(entity1)
              .addEntity(entity2)
              .build())
          .build())

### Java

    client.publishContinuationCluster(
                new PublishContinuationClusterRequest.Builder()
                    .setContinuationCluster(
                        new ContinuationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .build())
                    .build());

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
          .addClusterType(ClusterType.TYPE_CONTINUATION)
          .addClusterType(ClusterType.TYPE_FEATURED)
          .addClusterType(ClusterType.TYPE_RECOMMENDATION)
          .build())

### Java

    client.deleteClusters(
                new DeleteClustersRequest.Builder()
                    .addClusterType(ClusterType.TYPE_CONTINUATION)
                    .addClusterType(ClusterType.TYPE_FEATURED)
                    .addClusterType(ClusterType.TYPE_RECOMMENDATION)
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
                             new IntentFilter(com.google.android.engage.service.Intents. ACTION_PUBLISH_RECOMMENDATION),
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

The following [intents](https://developer.android.com/reference/android/content/Intent) is sent by the
service:

- `com.google.android.engage.action.PUBLISH_RECOMMENDATION` It is recommended to start a `publishRecommendationClusters` call when receiving this intent.
- `com.google.android.engage.action.PUBLISH_FEATURED` It is recommended to start a `publishFeaturedCluster` call when receiving this intent.
- `com.google.android.engage.action.PUBLISH_CONTINUATION` It is recommended to start a `publishContinuationCluster` call when receiving this intent.

## Integration workflow

For a step-by-step guide on verifying your integration after it is complete, see
[Engage developer integration workflow](https://developer.android.com/guide/playcore/engage/workflow).

## FAQs

See [Engage SDK Frequently Asked Questions](https://developer.android.com/guide/playcore/engage/faq) for
FAQs.

## Contact

Contact
[`engage-developers@google.com`](mailto:engage-developers@google.com) if there are
any questions during the integration process.

## Next steps

After completing this integration, your next steps are as follows:

- Send an email to [`engage-developers@google.com`](mailto:engage-developers@google.com) and attach your integrated APK that is ready for testing by Google.
- Google performs a verification and reviews internally to make sure the integration works as expected. If changes are needed, Google contacts you with any necessary details.
- When testing is complete and no changes are needed, Google contacts you to notify you that you can start publishing the updated and integrated APK to the Play Store.
- After Google has confirmed that your updated APK has been published to the Play Store, your **Recommendation** , **Featured** , and **Continuation** clusters may be published and visible to users.