This guide contains instructions for developers to integrate their recommended
video content, using the [Engage SDK](https://developer.android.com/guide/playcore/engage), to populate recommendations
experiences across Google surfaces, such as TV, mobile, and tablet.

Recommendation leverages the **Recommendation cluster** to show movies and TV
shows, from multiple apps in one UI grouping. Each developer partner can
broadcast a maximum **of 25 entities** in each recommendations cluster and there
can be a maximum **of 7** recommendation clusters per request.

## Pre-work

> [!IMPORTANT]
> **Important:** [Express interest in developing with Engage](http://g.co/tv/vda).

Complete the [Pre-work](https://developer.android.com/guide/playcore/engage/tv/getting-started#pre-work) instructions in the Getting Started guide.

1. Execute publishing on a foreground service.
2. Publish recommendations data at most once daily, triggered by either of
   - User's first login of the day. (*or*)
   - When the user starts interacting with the application.

## Integration

`AppEngagePublishClient` publishes the recommendation cluster. Use the
`publishRecommendationClusters` method to publish a recommendations object.

Make sure to initialize the client and check for service availability as
described in the [Getting Started guide](https://developer.android.com/guide/playcore/engage/tv/getting-started#common-integration).

    client.publishRecommendationClusters(recommendationRequest)

### Upserting recommendation clusters

Clusters are logical grouping of the entities. The following code examples
explains how to build the clusters based on your preference and how to create a
publishing request and upsert all clusters.

The [`RecommendationClusterType`](https://developer.android.com/reference/com/google/android/engage/common/datamodel/RecommendationClusterType) determines how the
cluster will be displayed.

    // cluster for popular movies
    val recommendationCluster1 = RecommendationCluster
      .Builder()
      .addEntity(movie1)
      .addEntity(movie2)
      .addEntity(movie3)
      .addEntity(movie4)
      .addEntity(tvShow)
      // This cluster is meant to be used as an individual provider row
      .setRecommendationClusterType(TYPE_PROVIDER_ROW)
      .setTitle("Popular Movies")
      .build()

    // cluster for live TV programs
    val recommendationCluster2 = RecommendationCluster
      .Builder()
      .addEntity(liveTvProgramEntity1)
      .addEntity(liveTvProgramEntity2)
      .addEntity(liveTvProgramEntity3)
      .addEntity(liveTvProgramEntity4)
      .addEntity(liveTvProgramEntity5)
     // This cluster is meant to be used as an individual provider row
      .setRecommendationClusterType(TYPE_PROVIDER_ROW)
      .setTitle("Popular Live TV Programs")
      .build()

    // creating a publishing request
    val recommendationRequest = PublishRecommendationClustersRequest
      .Builder()
      .setSyncAcrossDevices(true)
      .setAccountProfile(accountProfile)
      .addRecommendationCluster(recommendationCluster1)
      .addRecommendationCluster(recommendationCluster2)
      .build()

When the service receives the request, the following actions occur within one
transaction:

- Existing `RecommendationsCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated `RecommendationsCluster`. In case of an error, the entire request is rejected and the existing state is maintained.

> [!NOTE]
> **Note:** Publish APIs are upsert operations, replacing existing content; update entities by republishing the entire cluster. Only publish recommendations for adult accounts. Avoid using delete APIs followed by publish, as the latter inherently replaces content.

### Cross-device sync

`SyncAcrossDevices` flag controls whether a user's recommendations cluster data
is shared with Google TV and available across their devices such as TV, phone,
tablets. In order for the recommendation to work, it must be set to true.

### Obtain consent

The media application must provide a clear setting to enable or disable
cross-device syncing. Explain the benefits to the user and store the user's
preference once and apply it in `publishRecommendations` Request accordingly. To
get the most out of cross-device feature, verify app obtains user
consent and enables `SyncAcrossDevices` to `true`.

### Delete the Engage data

To manually delete a user's data from the Google TV server before the standard
60-day retention period, use the `client.deleteClusters()` method. Upon
receiving the request, the service deletes all existing Engage
data for the account profile, or for the entire account.

The [`DeleteReason`](https://developer.android.com/reference/com/google/android/engage/service/DeleteReason) enum defines the reason for data deletion.
The following code removes recommendations on logout.

    // If the user logs out from your media app, you must make the following call
    // to remove recommendations data from the current Google TV device, otherwise,
    // the recommendations data persists on the current Google TV device until 60
    // days later.
    client.deleteClusters(
      new DeleteClustersRequest.Builder()
        .setAccountProfile(AccountProfile())
        .setReason(DeleteReason.DELETE_REASON_USER_LOG_OUT)
        .build()
    )

    // If the user revokes the consent to share data with Google TV, you must make
    // the following call to remove recommendations data from all current Google TV
    // devices. Otherwise, the recommendations data persists until 60 days later.
    client.deleteClusters(
      new DeleteClustersRequest.Builder()
        .setAccountProfile(AccountProfile())
        .setReason(DeleteReason.DELETE_REASON_LOSS_OF_CONSENT)
        .build()
    )

## Create entities

The SDK has defined different entities to represent each item type. Following
entities are supported for the Recommendation cluster:

1. [`MediaActionFeedEntity`](https://developer.android.com/reference/com/google/android/engage/video/datamodel/MediaActionFeedEntity)
2. [`MovieEntity`](https://developer.android.com/reference/com/google/android/engage/video/datamodel/MovieEntity)
3. [`TvShowEntity`](https://developer.android.com/reference/com/google/android/engage/video/datamodel/TvShowEntity)
4. [`LiveTvChannelEntity`](https://developer.android.com/reference/com/google/android/engage/video/datamodel/LiveTvChannelEntity)
5. [`LiveTvProgramEntity`](https://developer.android.com/reference/com/google/android/engage/video/datamodel/LiveTvProgramEntity)

### Provide descriptions

Provide a short description for each entity; this description will be displayed
when users hover over the entity, providing them with additional details.

### Call to action text

Provide an optional call to action text for each entity. This text will be
displayed to the user to encourage engagement.

### Tags

Optionally provide a list of tags for each entity. Tags can be used for
categorization and filtering.

### Platform specific playBack URIs

Create playback URIs for each supported platform: Android TV, Android, or iOS.
This allows the system to select the appropriate URI for video playback on the
respective platform.

In the rare case when the playback URIs are identical for all platforms,
repeat it for every platform.

    // Required. Set this when you want recommended entities to show up on
    // Google TV
    val playbackUriTv = PlatformSpecificUri
      .Builder()
      .setPlatformType(PlatformType.TYPE_ANDROID_TV)
      .setActionUri(Uri.parse("https://www.example.com/entity_uri_for_tv"))
      .build()

    // Optional. Set this when you want recommended entities to show up on
    // Google TV Android app
    val playbackUriAndroid = PlatformSpecificUri
      .Builder()
      .setPlatformType(PlatformType.TYPE_ANDROID_MOBILE)
      .setActionUri(Uri.parse("https://www.example.com/entity_uri_for_android"))
      .build()

    // Optional. Set this when you want recommended entities to show up on
    // Google TV iOS app
    val playbackUriIos = PlatformSpecificUri
      .Builder()
      .setPlatformType(PlatformType.TYPE_IOS)
      .setActionUri(Uri.parse("https://www.example.com/entity_uri_for_ios"))
      .build()

    val platformSpecificPlaybackUris =
      Arrays.asList(playbackUriTv, playbackUriAndroid, playbackUriIos)

    // Provide appropriate rating for the system.
    val contentRating = new RatingSystem
      .Builder()
      .setAgencyName("MPAA")
      .setRating("PG-13")
      .build()

### Poster images

Poster images require a URI and pixel dimensions (height and width). Target
different form factors by providing multiple poster images, but verify all
images maintain a 16:9 aspect ratio and a minimum height of 200 pixels for
correct display of the "Recommendations" entity, especially within Google's
[Entertainment Space](https://support.google.com/entertainmentspace/answer/10346911). Images with a height less than 200
pixels may not be shown.

    Image image1 = new Image.Builder()
      .setImageUri(Uri.parse("http://www.example.com/entity_image1.png");)
      .setImageHeightInPixel(300)
      .setImageWidthInPixel(169)
      .build()

    Image image2 = new Image.Builder()
      .setImageUri(Uri.parse("http://www.example.com/entity_image2.png");)
      .setImageHeightInPixel(640)
      .setImageWidthInPixel(360)
      .build()

    // And other images for different form factors.
    val images = Arrays.asList(image1, image2)

### Recommendation reason

Optionally provide a recommendation reason which can be used by Google
TV to construct reasons as to why to suggest a specific Movie or TV Show to
the user.

    //Allows us to construct reason: "Because it is top 10 on your Channel"
    val topOnPartner = RecommendationReasonTopOnPartner
      .Builder()
      .setNum(10) //any valid integer value
      .build()

    //Allows us to construct reason: "Because it is popular on your Channel"
    val popularOnPartner = RecommendationReasonPopularOnPartner
      .Builder()
      .build()

    //Allows us to construct reason: "New to your channel, or Just added"
    val newOnPartner = RecommendationReasonNewOnPartner
      .Builder()
      .build()

    //Allows us to construct reason: "Because you watched Star Wars"
    val watchedSimilarTitles = RecommendationReasonWatchedSimilarTitles
      .addSimilarWatchedTitleName("Movie or TV Show Title")
      .addSimilarWatchedTitleName("Movie or TV Show Title")
      .Builder()
      .build()

    //Allows us to construct reason: "Recommended for you by ChannelName"
    val recommendedForUser = RecommendationReasonRecommendedForUser
      .Builder()
      .build()

    val watchAgain = RecommendationReasonWatchAgain
      .Builder()
      .build()

    val fromUserWatchList = RecommendationReasonFromUserWatchlist
      .Builder()
      .build()

    val userLikedOnPartner = RecommendationReasonUserLikedOnPartner
      .Builder()
      .setTitleName("Movie or TV Show Title")
      .build()

    val generic = RecommendationReasonGeneric.Builder().build()

### Display time window

If an entity should only be available for a limited time, set a custom
expiration time. Without an explicit expiration time, entities will
automatically expire and be erased after 60 days. So set an expiration time only
when the entities need to be expired sooner. Specify multiple such
availability windows.

    val window1 = DisplayTimeWindow
      .Builder()
      .setStartTimeStampMillis(now()+ 1.days.toMillis())
      .setEndTimeStampMillis(now()+ 30.days.toMillis())

    val window2 = DisplayTimeWindow
      .Builder()
      .setEndTimeStampMillis(now()+ 30.days.toMillis())

    val availabilityTimeWindows: List<DisplayTimeWindow> = listof(window1,window2)

### DataFeedElementId

If you have integrated your Media catalogue or Media action feed with Google TV,
you need not create separate entities for Movie or TV Show and instead you can
create a [`MediaActionFeedEntity`](https://developer.android.com/reference/com/google/android/engage/video/datamodel/MediaActionFeedEntity) which includes the
required field DataFeedElementId. This Id must be unique and must match with the
ID in Media Action Feed as it helps to identify ingested feed content and
perform media content lookups.

    val id = "dataFeedElementId"

### `MovieEntity`

Here's an example of creating a `MovieEntity` with all the required fields:

    val movieEntity = MovieEntity.Builder()
      .setName("Movie name")
      .setDescription("A sentence describing movie.")
      .addPlatformSpecificPlaybackUri(platformSpecificPlaybackUris)
      .addPosterImages(images)
      // Suppose the duration is 2 hours, it is 72000000 in milliseconds
      .setDurationMills(72000000)
      .setCallToActionText("Watch Now")
      .addTag("Action")
      .build()

You can provide additional data such as genres, content ratings, release date,
recommendation reason and availability time windows, which may be used by Google
TV for enhanced displays or filtering purposes.

    val genres = Arrays.asList("Action", "Science fiction");
    val rating1 = RatingSystem.Builder().setAgencyName("MPAA").setRating("pg-13").build();
    val contentRatings = Arrays.asList(rating1);
    //Suppose release date is 11-02-2025
    val releaseDate  = 1739233800000L
    val movieEntity = MovieEntity.Builder()
      ...
      .addGenres(genres)
      .setReleaseDateEpochMillis(releaseDate)
      .addContentRatings(contentRatings)
      .setRecommendationReason(topOnPartner or watchedSimilarTitles)
      .addAllAvailabilityTimeWindows(availabilityTimeWindows)
      .build()

### `TvShowEntity`

Here's an example of creating a `TvShowEntity` with all the required fields:

    val tvShowEntity = TvShowEntity.Builder()
      .setName("Show title")
      .setDescription("A sentence describing TV Show.")
      .addPlatformSpecificPlaybackUri(platformSpecificPlaybackUris)
      .addPosterImages(images)
      .setCallToActionText("Watch Now")
      .addTag("Drama")
      .build();

Optionally provide additional data such as genres, content ratings,
recommendation reason, offer price, season count or availability time window,
which may be used by Google TV for enhanced displays or filtering purposes.

    val genres = Arrays.asList("Action", "Science fiction");
    val rating1 = RatingSystem.Builder()
      .setAgencyName("MPAA")
      .setRating("pg-13")
      .build();
    val price = Price.Builder()
      .setCurrentPrice("$14.99")
      .setStrikethroughPrice("$16.99")
      .build();
    val contentRatings = Arrays.asList(rating1);
    val seasonCount = 5;
    val tvShowEntity = TvShowEntity.Builder()
      ...
      .addGenres(genres)
      .addContentRatings(contentRatings)
      .setRecommendationReason(topOnPartner or watchedSimilarTitles)
      .addAllAvailabilityTimeWindows(availabilityTimeWindows)
      .setSeasonCount(seasonCount)
      .setPrice(price)
      .build()

### `MediaActionFeedEntity`

Here's an example of creating an `MediaActionFeedEntity` with all the required
fields:

    val mediaActionFeedEntity = MediaActionFeedEntity.Builder()
      .setDataFeedElementId(id)
      .setCallToActionText("Watch Now")
      .addTag("Action")
      .build()

Optionally provide additional data such as description, recommendation reason
and display time window, which may be used by Google TV for enhanced displays or
filtering purposes.

    val mediaActionFeedEntity = MediaActionFeedEntity.Builder()
      .setName("Movie name or TV Show name")
      .setDescription("A sentence describing an entity")
      .setRecommendationReason(topOnPartner or watchedSimilarTitles)
      .addPosterImages(images)
      .build()

### `LiveTvChannelEntity`

This represents a live TV channel. Here's an example of creating a
`LiveTvChannelEntity` with all the required fields:

    val liveTvChannelEntity = LiveTvChannelEntity.Builder()
      .setName("Channel Name")
      // ID of the live TV channel
      .setEntityId("https://www.example.com/channel/12345")
      .setDescription("A sentence describing this live TV channel.")
      // channel playback uri must contain at least PlatformType.TYPE_ANDROID_TV
      .addPlatformSpecificPlaybackUri(channelPlaybackUris)
      .addLogoImage(logoImage)
      .setCallToActionText("Watch Now")
      .addTag("News")
      .build()

Optionally provide additional data such as content ratings or
recommendation reason.

    val rating1 = RatingSystem.Builder()
      .setAgencyName("MPAA")
      .setRating("pg-13")
      .build()
    val contentRatings = Arrays.asList(rating1)

    val liveTvChannelEntity = LiveTvChannelEntity.Builder()
      ...
      .addContentRatings(contentRatings)
      .setRecommendationReason(topOnPartner)
      .build()

### `LiveTvProgramEntity`

This represents a live TV program card airing or scheduled to air on
a live TV channel. Here's an example of creating a `LiveTvProgramEntity`
with all the required fields:

    val liveTvProgramEntity = LiveTvProgramEntity.Builder()
      // First set the channel information
      .setChannelName("Channel Name")
      .setChannelId("https://www.example.com/channel/12345")
      // channel playback uri must contain at least PlatformType.TYPE_ANDROID_TV
      .addPlatformSpecificPlaybackUri(channelPlaybackUris)
      .setChannelLogoImage(channelLogoImage)
      // Then set the program or card specific information.
      .setName("Program Name")
      .setEntityId("https://www.example.com/schedule/123")
      .setDescription("Program Description")
      .addAvailabilityTimeWindow(
          DisplayTimeWindow.Builder()
            .setStartTimestampMillis(1756713600000L)// 2025-09-01T07:30:00+0000
            .setEndTimestampMillis(1756715400000L))// 2025-09-01T08:00:00+0000
      .addPosterImage(programImage)
      .setCallToActionText("Watch Now")
      .addTag("Sports")
      .build()

Optionally provide additional data such as content ratings, genres, or
recommendation reason.

    val rating1 = RatingSystem.Builder()
      .setAgencyName("MPAA")
      .setRating("pg-13")
      .build()
    val contentRatings = Arrays.asList(rating1)
    val genres = Arrays.asList("Action", "Science fiction")

    val liveTvProgramEntity = LiveTvProgramEntity.Builder()
      ...
      .addContentRatings(contentRatings)
      .addGenres(genres)
      .setRecommendationReason(topOnPartner)
      .build()

> [!NOTE]
> **Note:** If the additional fields are provided directly within the entity, these values will be prioritized. The locale, if provided in the Account Profile, will be used to fetch the remaining entity metadata from Google's database in the language consistent with the request.