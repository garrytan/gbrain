Boost app engagement by reaching your users where they are. Integrate Engage SDK
to deliver personalized recommendations and continuation content directly to
users across multiple on-device surfaces, like
**[Collections](https://android-developers.googleblog.com/2024/07/introducing-collections-powered-by-engage-sdk.html)** , **[Entertainment
Space](https://blog.google/products/android/entertainment-space/)** , and the Play Store. The integration adds
less than 50 KB (compressed) to the average APK and takes most apps about a
week of developer time. Learn more at our **[business
site](http://play.google.com/console/about/programs/EngageSDK)**.

This guide contains instructions for developer partners to deliver audio content
(music, podcasts, audiobooks, live radio) to Engage content surfaces.

## Integration detail

### Terminology

This integration includes the following three cluster types: **Recommendation** ,
**Continuation** , and **Featured**.

- **Recommendation** clusters show personalized suggestions for content to read
  from an individual developer partner.

  Your recommendations take the following structure:
  - **Recommendation Cluster:** A UI view that contains a group of
    recommendations from the same developer partner.

    ![](https://developer.android.com/static/images/guide/playcore/engage/listen-term-1.png) **Figure 1.** Entertainment Space UI showing a Recommendation Cluster from a single partner.
  - **Entity:** An object representing a single item in a cluster. An entity
    can be a playlist, an audiobook, a podcast, and more. See the [Provide
    entity data](https://developer.android.com/guide/playcore/engage/listen#provide-entity-data) section for a list of supported entity
    types.

    ![](https://developer.android.com/static/images/guide/playcore/engage/listen-term-2.png) **Figure 2.** Entertainment Space UI showing a single Entity within a single partner's Recommendation Cluster.
- The **Continuation** cluster shows audio content recently engaged by users
  from multiple developer partners in a single UI grouping. Each developer
  partner will be allowed to broadcast a maximum of 10 entities in the
  Continuation cluster.

  ![](https://developer.android.com/static/images/guide/playcore/engage/listen-term-3.png) **Figure 3.** Entertainment Space UI showing a Continuation cluster with unfinished recommendations from multiple partners (only one recommendation is currently visible).
- The **Featured** cluster showcases a selection of items from multiple
  developer partners in a single UI grouping. There will be a single Featured
  cluster, which will be surfaced near the top of the UI with a priority
  placement above all Recommendation clusters. Each developer partner will be
  allowed to broadcast up to 10 entities in the Featured cluster.

  ![](https://developer.android.com/static/images/guide/playcore/engage/listen-term-4.png) **Figure 4.** Entertainment Space UI showing a Featured cluster with recommendations from multiple partners (only one recommendation is currently visible).

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
the following entities for the Listen category:

1. `MusicAlbumEntity`
2. `MusicArtistEntity`
3. `MusicTrackEntity`
4. `MusicVideoEntity`
5. `PlaylistEntity`
6. `PodcastSeriesEntity`
7. `PodcastEpisodeEntity`
8. `LiveRadioStationEntity`
9. `AudiobookEntity`

The charts below outline available attributes and requirements for each type.

#### `MusicAlbumEntity`

The `MusicAlbumEntity` object represents a music album (for example, *Midnights*
by Taylor Swift).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** | The title of the music album. |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
| Info page uri | **Required** | The deep link to the provider app for details about the music album. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Artists | **Required** | List of artists in the music album. |
| Playback uri | Optional | A deep link that starts playing the album in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Description | Optional | Must be within 200 characters if provided. |
| Songs count | Optional | The number of songs in the music album. |
| Genres | Optional | List of genres in the music album. |
| Album Format | Optional | ALBUM (includes LP and double LP) EP SINGLE Mixtape |
| Music labels | Optional | List of music labels associated with the album. |
| Downloaded on Device | Optional | Boolean indicating if the music album is downloaded on device. |
| Explicit | Optional | A boolean indicating if the content is explicit or not Items that contain explicit material or have a parental advisory warning should be set to TRUE. Explicit items appears with an "E" tag. |
| Release date | Optional | The release date of the album in epoch milliseconds. |
| Duration | Optional | The duration of the album in milliseconds. |
| Last engagement time | Optional | Recommended for items in the Continuation Cluster. May be used for ranking. In epoch milliseconds |
| Progress percentage complete | Optional | Recommended for items in the Continuation Cluster. Integer between 0 and 100 |

#### `MusicArtistEntity`

The `MusicArtistEntity` object represents a music arist (for example, Adele).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** | Name of the music artist. |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
| Info page uri | **Required** | The deep link to the provider app for details about the music artist. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Playback uri | Optional | The deep link which starts playing the artist's songs in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Description | Optional | Must be within 200 characters if provided. |
| Last engagement time | Optional | Recommended for items in the Continuation Cluster. May be used for ranking. In epoch milliseconds |

#### `MusicTrackEntity`

The `MusicTrackEntity` object represents a music track (for example, *Yellow* by
Coldplay).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** | Title of the music track. |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
| Playback uri | **Required** | A deep link that starts playing the music track in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Artists | **Required** | List of artists for the music track. |
| Info page uri | Optional | A deep link to the provider app for details about the music track. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Description | Optional | Must be within 200 characters if provided. |
| Duration | Optional | The duration of the track in milliseconds. |
| Album | Optional | The name of the album to which the song belongs. |
| Downloaded on Device | Optional | Boolean indicating if the music track is downloaded on device. |
| Explicit | Optional | A boolean indicating if the content is explicit or not Items that contain explicit material or have a parental advisory warning should be set to TRUE. Explicit items appears with an "E" tag. |
| Last engagement time | Optional | Recommended for items in the Continuation Cluster. May be used for ranking. In epoch milliseconds |
| Progress percentage complete | Optional | Recommended for items in the Continuation Cluster. Integer between 0 and 100 |

#### `MusicVideoEntity`

The `MusicVideoEntity` object represents a music video (for example,
*The Weeknd - Take My Breath (Official Music Video)*).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** | Title of the music video. |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
| Playback uri | **Required** | A deep link that starts playing the music video in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Info page uri | Optional | A deep link to the provider app for details about the music video. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Duration | Optional | The duration of the video in milliseconds. |
| View count | Optional | The number of views on the video in free text format. |
| Artists | Optional | List of artists of the music video. |
| Content rating | Optional | List of content ratings of the track. |
| Description | Optional | Must be within 200 characters if provided. |
| Downloaded on Device | Optional | Boolean indicating if the music video is downloaded on device. |
| Explicit | Optional | A boolean indicating if the content is explicit or not Items that contain explicit material or have a parental advisory warning should be set to TRUE. Explicit items appears with an "E" tag. |
| Last engagement time | Optional | Recommended for items in the Continuation Cluster. May be used for ranking. In epoch milliseconds |
| Progress percentage complete | Optional | Recommended for items in the Continuation Cluster. Integer between 0 and 100 |

#### `PlaylistEntity`

The `PlaylistEntity` object represents a music playlist (for example, the US Top
10 Playlist).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** | Title of the playlist. |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
| Playback uri | **Required** | A deep link that starts playing the music playlist in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Info page uri | Optional | A deep link to the provider app for details about the music playlist. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Duration | Optional | The duration of the playlist in milliseconds. |
| Songs count | Optional | The number of songs in the music playlist. |
| Description | Optional | Must be within 200 characters if provided. |
| Downloaded on Device | Optional | Boolean indicating if the playlist is downloaded on device. |
| Explicit | Optional | A boolean indicating if the content is explicit or not Items that contain explicit material or have a parental advisory warning should be set to TRUE. Explicit items appears with an "E" tag. |
| Last engagement time | Optional | Recommended for items in the Continuation Cluster. May be used for ranking. In epoch milliseconds |
| Progress percentage complete | Optional | Recommended for items in the Continuation Cluster. Integer between 0 and 100 |

#### `PodcastSeriesEntity`

The `PodcastSeriesEntity` object represents a podcast series (for example, *This
American Life*).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** | Title of the podcast series. |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
| Info page uri | **Required** | A deep link to the provider app for details about the podcast series. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Playback uri | Optional | A deep link that starts playing the podcast series in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Episode count | Optional | The number of episodes in the podcast series. |
| Production name | Optional | The name of the production of the podcast series. |
| Hosts | Optional | List of hosts of the podcast series. |
| Genres | Optional | List of genres of the podcast series. |
| Downloaded on device | Optional | Boolean indicating if the podcast is downloaded on the device. |
| Description | Optional | Must be within 200 characters if provided. |
| Explicit | Optional | A boolean indicating if the content is explicit or not Items that contain explicit material or have a parental advisory warning should be set to TRUE. Explicit items appears with an "E" tag. |
| Last engagement time | Optional | Recommended for items in the Continuation Cluster. May be used for ranking. In epoch milliseconds |

#### `PodcastEpisodeEntity`

The `PodcastEpisodeEntity` object represents a podcast series (for example,
*Spark Bird, Episode 754: This American Life*).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** | Title of the podcast episode. |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
| Playback uri | **Required** | A deep link that starts playing the podcast episode in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Podcast series title | **Required** | The name of the podcast series to which the episode belongs. |
| Duration | **Required** | The duration of the podcast episode in milliseconds. |
| Publish Date | **Required** | Publish date of the podcast (in epoch milliseconds) |
| Info page uri | Optional | A deep link to the provider app for details about the podcast episode. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Production name | Optional | The name of the production of the podcast series. |
| Episode index | Optional | The index of the episode in the series (first index is 1). |
| Hosts | Optional | List of hosts of the podcast episode. |
| Genres | Optional | List of genres of the podcast episode. |
| Downloaded on device | Optional | Boolean indicating if the podcast episode is downloaded on the device. |
| Description | Optional | Must be within 200 characters if provided. |
| Video Podcast | Optional | Boolean indicating if the podcast episode has video content |
| Explicit | Optional | A boolean indicating if the content is explicit or not Items that contain explicit material or have a parental advisory warning should be set to TRUE. Explicit items appears with an "E" tag. |
| Listen Next Type | Optional | Recommended for Items in the Continuation Cluster TYPE_CONTINUE - Resume on a unfinished audio item. TYPE_NEXT - Continue on a new one of a series. TYPE_NEW - Newly released. |
| Last engagement time | Optional | Recommended for items in the Continuation Cluster. May be used for ranking. In epoch milliseconds |
| Progress percentage complete | Optional | Recommended for items in the Continuation Cluster. Integer between 0 and 100 |

#### `LiveRadioStationEntity`

The `LiveRadioStationEntity` object represents a live radio station (for
example, 98.1 The Breeze).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** | Title of the live radio station. |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
| Playback uri | **Required** | A deep link that starts playing the radio station in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Info page uri | Optional | A deep link to the provider app for details about the radio station. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) |
| Frequency | Optional | The frequency at which the radio station is broadcasted (for example, "98.1 FM"). |
| Show title | Optional | The current show that is playing on the radio station. |
| Hosts | Optional | List of hosts of the radio station. |
| Description | Optional | Must be within 200 characters if provided. |
| Last engagement time | Optional | Recommended for items in the Continuation Cluster. May be used for ranking. In epoch milliseconds |

#### `AudiobookEntity`

The `AudiobookEntity` object represents an audiobook (for example, the audiobook
of *Becoming* by Michelle Obama).

| Attribute | Requirement | Notes |
|---|---|---|
| Name | **Required** |   |
| Poster images | **Required** | At least one image must be provided. See [Image Specifications](https://developer.android.com/guide/playcore/engage/listen#image-specs) for guidance. |
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

#### Image specifications

Required specifications for image assets are listed below:

| Aspect ratio | Requirement | Minimum pixels | Recommended pixels |
|---|---|---|---|
| Square (1x1) | **Required** | 300x300 | 1200x1200 |
| Landscape (1.91x1) | Optional | 600x314 | 1200x628 |
| Portrait (4x5) | Optional | 480x600 | 960x1200 |

*File formats*

PNG, JPG, static GIF, WebP

*Maximum file size*

5120 KB

*Additional recommendations*

- **Image safe area:** Put your important content in the center 80% of the image.

#### Examples

    MusicAlbumEntity musicAlbumEntity =
            new MusicAlbumEntity.Builder()
                .setName(NAME)
                 .addPosterImage(new Image.Builder()
                      .setImageUri(Uri.parse("http://www.x.com/image.png"))
                      .setImageHeightInPixel(960)
                      .setImageWidthInPixel(408)
                      .build())
                .setPlayBackUri("https://play.google/album/play")
                .setInfoPageUri("https://play.google/album/info")
                .setDescription("A description of this album.")
                .addArtist("Artist")
                .addGenre("Genre")
                .addMusicLabel("Label")
                .addContentRating("Rating")
                .setSongsCount(960)
                .setReleaseDateEpochMillis(1633032895L)
                .setDurationMillis(1633L)
                .build();

    AudiobookEntity audiobookEntity =
            new AudiobookEntity.Builder()
                .setName("Becoming")
                .addPosterImage(new Image.Builder()
                     .setImageUri(Uri.parse("http://www.x.com/image.png"))
                     .setImageHeightInPixel(960)
                     .setImageWidthInPixel(408)
                      .build())
                .addAuthor("Michelle Obama")
                .addNarrator("Michelle Obama")
                .setActionLinkUri(
                   Uri.parse("https://play.google/audiobooks/1"))
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
Listening) will be still enabled by default configuration, and the rest of
the cluster types will be enabled and disabled intermittently. If
intermittent ingestion applies to you but this default configuration is not
suitable for your needs, please contact engage-developers@google.com.

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
                            .setTitle("Trending music")
                            .build())
                    .build())

### Java

    client.publishRecommendationClusters(
                new PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        new RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Trending music")
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
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .build())
                    .build())

### Java

    client.publishContinuationCluster(
                PublishContinuationClusterRequest.Builder()
                    .setContinuationCluster(
                        ContinuationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
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
any questions during the integration process. Our team will reply as soon as
possible.

## Next steps

After completing this integration, your next steps are as follows:

- Send an email to [`engage-developers@google.com`](mailto:engage-developers@google.com) and attach your integrated APK that is ready for testing by Google.
- Google will perform a verification and review internally to make sure the integration works as expected. If changes are needed, Google will contact you with any necessary details.
- When testing is complete and no changes are needed, Google will contact you to notify you that you can start publishing the updated and integrated APK to the Play Store.
- After Google has confirmed that your updated APK has been published to the Play Store, your **Recommendation** , **Featured** , and **Continuation** clusters will be published and visible to users.