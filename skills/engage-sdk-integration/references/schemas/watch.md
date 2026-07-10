This file defines the schema for the WATCH vertical in the Engage SDK.

    {
      "client": "com.google.android.engage.service.AppEngagePublishClient",
      "clusterTypes": [
        "TYPE_RECOMMENDATION",
        "TYPE_FEATURED",
        "TYPE_CONTINUATION"
      ],
      "entities": {
        "MovieEntity": {
          "package": "com.google.android.engage.video.datamodel.MovieEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "watchNextType": {
              "type": "@WatchNextType int",
              "requirement": "Optional",
              "setter": "setWatchNextType(@WatchNextType int)",
              "getter": "getWatchNextType()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "lastPlayBackPositionTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastPlayBackPositionTimeMillis(long)",
              "getter": "getLastPlayBackPositionTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "availabilityTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addAvailabilityTimeWindow(DisplayTimeWindow)",
              "getter": "getAvailabilityTimeWindows()"
            },
            "allAvailabilityTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllAvailabilityTimeWindows(DisplayTimeWindow)",
              "adderAll": "addAllAvailabilityTimeWindows(List<DisplayTimeWindow>)"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "infoPageUri": {
              "type": "Uri",
              "requirement": "Optional",
              "setter": "setInfoPageUri(Uri)",
              "getter": "getInfoPageUri()"
            },
            "releaseDateEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setReleaseDateEpochMillis(long)",
              "getter": "getReleaseDateEpochMillis()"
            },
            "availability": {
              "type": "@ContentAvailability int",
              "requirement": "Required",
              "setter": "setAvailability(@ContentAvailability int)",
              "getter": "getAvailability()"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setDurationMillis(long)",
              "getter": "getDurationMillis()"
            },
            "genres": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "contentRatings": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addContentRating(RatingSystem)",
              "getter": "getContentRatings()",
              "adderAll": "addContentRatings(List<RatingSystem>)"
            },
            "contentRatingsLegacies": {
              "type": "List<List<String>>",
              "requirement": "Required",
              "adder": "addContentRatingsLegacy(String)",
              "getter": "getContentRatingsLegacy()",
              "adderAll": "addContentRatingsLegacy(List<String>)"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "price": {
              "type": "Price",
              "requirement": "Optional",
              "setter": "setPrice(Price)",
              "getter": "getPrice()"
            },
            "platformSpecificPlaybackUris": {
              "type": "List<PlatformSpecificUri>",
              "requirement": "Optional",
              "adder": "addPlatformSpecificPlaybackUri(PlatformSpecificUri)",
              "getter": "getPlatformSpecificPlaybackUris()",
              "adderAll": "addPlatformSpecificPlaybackUris(List<PlatformSpecificUri>)"
            },
            "recommendationReason": {
              "type": "@NonNull RecommendationReason",
              "requirement": "Optional",
              "setter": "setRecommendationReason(@NonNull RecommendationReason)",
              "getter": "getRecommendationReason()"
            },
            "description": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setDescription(@NonNull String)",
              "getter": "getDescription()"
            },
            "callToActionText": {
              "requirement": "Optional",
              "setter": "setCallToActionText(@NonNull String)",
              "type": "@NonNull String",
              "getter": "getCallToActionText()"
            },
            "tags": {
              "requirement": "Optional",
              "adder": "addTag(@NonNull String)",
              "type": "List<@NonNull String>",
              "adderAll": "addTags(List<String>)",
              "getter": "getTags()"
            }
          }
        },
        "TvShowEntity": {
          "package": "com.google.android.engage.video.datamodel.TvShowEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "watchNextType": {
              "type": "@WatchNextType int",
              "requirement": "Optional",
              "setter": "setWatchNextType(@WatchNextType int)",
              "getter": "getWatchNextType()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "lastPlayBackPositionTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastPlayBackPositionTimeMillis(long)",
              "getter": "getLastPlayBackPositionTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "availabilityTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addAvailabilityTimeWindow(DisplayTimeWindow)",
              "getter": "getAvailabilityTimeWindows()"
            },
            "allAvailabilityTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllAvailabilityTimeWindows(DisplayTimeWindow)",
              "adderAll": "addAllAvailabilityTimeWindows(List<DisplayTimeWindow>)"
            },
            "infoPageUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setInfoPageUri(Uri)",
              "getter": "getInfoPageUri()"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Optional",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "firstEpisodeAirDateEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setFirstEpisodeAirDateEpochMillis(long)",
              "getter": "getFirstEpisodeAirDateEpochMillis()"
            },
            "latestEpisodeAirDateEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLatestEpisodeAirDateEpochMillis(long)",
              "getter": "getLatestEpisodeAirDateEpochMillis()"
            },
            "availability": {
              "type": "@ContentAvailability int",
              "requirement": "Required",
              "setter": "setAvailability(@ContentAvailability int)",
              "getter": "getAvailability()"
            },
            "seasonCount": {
              "type": "Integer",
              "requirement": "Required",
              "setter": "setSeasonCount(int)",
              "getter": "getSeasonCount()"
            },
            "genres": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "contentRatings": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addContentRating(RatingSystem)",
              "getter": "getContentRatings()",
              "adderAll": "addContentRatings(List<RatingSystem>)"
            },
            "contentRatingsLegacies": {
              "type": "List<List<String>>",
              "requirement": "Required",
              "adder": "addContentRatingsLegacy(String)",
              "getter": "getContentRatingsLegacy()",
              "adderAll": "addContentRatingsLegacy(List<String>)"
            },
            "price": {
              "type": "Price",
              "requirement": "Optional",
              "setter": "setPrice(Price)",
              "getter": "getPrice()"
            },
            "platformSpecificPlaybackUris": {
              "type": "List<PlatformSpecificUri>",
              "requirement": "Required",
              "adder": "addPlatformSpecificPlaybackUri(PlatformSpecificUri)",
              "getter": "getPlatformSpecificPlaybackUris()",
              "adderAll": "addPlatformSpecificPlaybackUris(List<PlatformSpecificUri>)"
            },
            "recommendationReason": {
              "type": "@NonNull RecommendationReason",
              "requirement": "Optional",
              "setter": "setRecommendationReason(@NonNull RecommendationReason)",
              "getter": "getRecommendationReason()"
            },
            "description": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setDescription(@NonNull String)",
              "getter": "getDescription()"
            },
            "callToActionText": {
              "requirement": "Optional",
              "setter": "setCallToActionText(@NonNull String)",
              "type": "@NonNull String",
              "getter": "getCallToActionText()"
            },
            "tags": {
              "requirement": "Optional",
              "adder": "addTag(@NonNull String)",
              "type": "List<@NonNull String>",
              "adderAll": "addTags(List<String>)",
              "getter": "getTags()"
            }
          }
        },
        "TvSeasonEntity": {
          "package": "com.google.android.engage.video.datamodel.TvSeasonEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "watchNextType": {
              "type": "@WatchNextType int",
              "requirement": "Optional",
              "setter": "setWatchNextType(@WatchNextType int)",
              "getter": "getWatchNextType()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "lastPlayBackPositionTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastPlayBackPositionTimeMillis(long)",
              "getter": "getLastPlayBackPositionTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "availabilityTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addAvailabilityTimeWindow(DisplayTimeWindow)",
              "getter": "getAvailabilityTimeWindows()"
            },
            "allAvailabilityTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllAvailabilityTimeWindows(DisplayTimeWindow)",
              "adderAll": "addAllAvailabilityTimeWindows(List<DisplayTimeWindow>)"
            },
            "infoPageUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setInfoPageUri(Uri)",
              "getter": "getInfoPageUri()"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Optional",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "seasonNumber": {
              "type": "Integer",
              "requirement": "Required",
              "setter": "setSeasonNumber(int)"
            },
            "seasonDisplayNumber": {
              "type": "String",
              "requirement": "Required",
              "setter": "setSeasonDisplayNumber(String)",
              "getter": "getSeasonDisplayNumber()"
            },
            "firstEpisodeAirDateEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setFirstEpisodeAirDateEpochMillis(long)",
              "getter": "getFirstEpisodeAirDateEpochMillis()"
            },
            "latestEpisodeAirDateEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLatestEpisodeAirDateEpochMillis(long)",
              "getter": "getLatestEpisodeAirDateEpochMillis()"
            },
            "availability": {
              "type": "@ContentAvailability int",
              "requirement": "Required",
              "setter": "setAvailability(@ContentAvailability int)",
              "getter": "getAvailability()"
            },
            "episodeCount": {
              "type": "Integer",
              "requirement": "Required",
              "setter": "setEpisodeCount(int)",
              "getter": "getEpisodeCount()"
            },
            "genres": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "contentRatings": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addContentRating(RatingSystem)",
              "getter": "getContentRatings()",
              "adderAll": "addContentRatings(List<RatingSystem>)"
            },
            "contentRatingsLegacies": {
              "type": "List<List<String>>",
              "requirement": "Required",
              "adder": "addContentRatingsLegacy(String)",
              "getter": "getContentRatingsLegacy()",
              "adderAll": "addContentRatingsLegacy(List<String>)"
            },
            "price": {
              "type": "Price",
              "requirement": "Optional",
              "setter": "setPrice(Price)",
              "getter": "getPrice()"
            }
          }
        },
        "TvEpisodeEntity": {
          "package": "com.google.android.engage.video.datamodel.TvEpisodeEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "watchNextType": {
              "type": "@WatchNextType int",
              "requirement": "Optional",
              "setter": "setWatchNextType(@WatchNextType int)",
              "getter": "getWatchNextType()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "lastPlayBackPositionTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastPlayBackPositionTimeMillis(long)",
              "getter": "getLastPlayBackPositionTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "availabilityTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addAvailabilityTimeWindow(DisplayTimeWindow)",
              "getter": "getAvailabilityTimeWindows()"
            },
            "allAvailabilityTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllAvailabilityTimeWindows(DisplayTimeWindow)",
              "adderAll": "addAllAvailabilityTimeWindows(List<DisplayTimeWindow>)"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "infoPageUri": {
              "type": "Uri",
              "requirement": "Optional",
              "setter": "setInfoPageUri(Uri)",
              "getter": "getInfoPageUri()"
            },
            "episodeNumber": {
              "type": "Integer",
              "requirement": "Required",
              "setter": "setEpisodeNumber(int)"
            },
            "episodeDisplayNumber": {
              "type": "String",
              "requirement": "Required",
              "setter": "setEpisodeDisplayNumber(String)",
              "getter": "getEpisodeDisplayNumber()"
            },
            "airDateEpochMillis": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setAirDateEpochMillis(long)",
              "getter": "getAirDateEpochMillis()"
            },
            "availability": {
              "type": "@ContentAvailability int",
              "requirement": "Required",
              "setter": "setAvailability(@ContentAvailability int)",
              "getter": "getAvailability()"
            },
            "genres": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "contentRatings": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addContentRating(RatingSystem)",
              "getter": "getContentRatings()",
              "adderAll": "addContentRatings(List<RatingSystem>)"
            },
            "contentRatingsLegacies": {
              "type": "List<List<String>>",
              "requirement": "Required",
              "adder": "addContentRatingsLegacy(String)",
              "getter": "getContentRatingsLegacy()",
              "adderAll": "addContentRatingsLegacy(List<String>)"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setDurationMillis(long)",
              "getter": "getDurationMillis()"
            },
            "seasonNumber": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setSeasonNumber(String)",
              "getter": "getSeasonNumber()"
            },
            "seasonTitle": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setSeasonTitle(String)",
              "getter": "getSeasonTitle()"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "price": {
              "type": "Price",
              "requirement": "Optional",
              "setter": "setPrice(Price)",
              "getter": "getPrice()"
            },
            "showTitle": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setShowTitle(String)",
              "getter": "getShowTitle()"
            },
            "isNextEpisodeAvailable": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setIsNextEpisodeAvailable(boolean)",
              "getter": "getIsNextEpisodeAvailable()"
            },
            "platformSpecificPlaybackUris": {
              "type": "List<PlatformSpecificUri>",
              "requirement": "Optional",
              "adder": "addPlatformSpecificPlaybackUri(PlatformSpecificUri)",
              "getter": "getPlatformSpecificPlaybackUris()",
              "adderAll": "addPlatformSpecificPlaybackUris(List<PlatformSpecificUri>)"
            },
            "callToActionText": {
              "requirement": "Optional",
              "setter": "setCallToActionText(@NonNull String)",
              "type": "@NonNull String",
              "getter": "getCallToActionText()"
            },
            "tags": {
              "requirement": "Optional",
              "adder": "addTag(@NonNull String)",
              "type": "List<@NonNull String>",
              "adderAll": "addTags(List<String>)",
              "getter": "getTags()"
            }
          }
        },
        "MediaActionFeedEntity": {
          "package": "com.google.android.engage.video.datamodel.MediaActionFeedEntity",
          "fields": {
            "dataFeedElementId": {
              "type": "@NonNull String",
              "requirement": "Required",
              "setter": "setDataFeedElementId(@NonNull String)",
              "getter": "getDataFeedElementId()"
            },
            "name": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setName(@NonNull String)",
              "getter": "getName()"
            },
            "recommendationReason": {
              "type": "@NonNull RecommendationReason",
              "requirement": "Optional",
              "setter": "setRecommendationReason(@NonNull RecommendationReason)",
              "getter": "getRecommendationReason()"
            },
            "description": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setDescription(@NonNull String)",
              "getter": "getDescription()"
            },
            "posterImages": {
              "type": "List<List<Image>>",
              "requirement": "Optional",
              "adder": "addPosterImage(@NonNull Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "callToActionText": {
              "requirement": "Optional",
              "setter": "setCallToActionText(@NonNull String)",
              "type": "@NonNull String",
              "getter": "getCallToActionText()"
            },
            "tags": {
              "requirement": "Optional",
              "adder": "addTag(@NonNull String)",
              "type": "List<@NonNull String>",
              "adderAll": "addTags(List<String>)",
              "getter": "getTags()"
            }
          }
        },
        "LiveTvProgramEntity": {
          "package": "com.google.android.engage.video.datamodel.LiveTvProgramEntity",
          "fields": {
            "channelId": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setChannelId(@NonNull String)",
              "getter": "getChannelId()"
            },
            "channelName": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setChannelName(@NonNull String)",
              "getter": "getChannelName()"
            },
            "channelLogoImage": {
              "type": "@NonNull Image",
              "requirement": "Optional",
              "setter": "setChannelLogoImage(@NonNull Image)",
              "getter": "getChannelLogoImage()"
            },
            "platformSpecificPlaybackUris": {
              "type": "List<@NonNull PlatformSpecificUri>",
              "requirement": "Optional",
              "adder": "addPlatformSpecificPlaybackUri(@NonNull PlatformSpecificUri)",
              "getter": "getPlatformSpecificPlaybackUris()",
              "adderAll": "addPlatformSpecificPlaybackUris(List<PlatformSpecificUri>)"
            },
            "contentRatings": {
              "type": "List<@NonNull RatingSystem>",
              "requirement": "Optional",
              "adder": "addContentRating(@NonNull RatingSystem)",
              "getter": "getContentRatings()",
              "adderAll": "addContentRatings(List<RatingSystem>)"
            },
            "genres": {
              "type": "List<@NonNull String>",
              "requirement": "Optional",
              "adder": "addGenre(@NonNull String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "availabilityTimeWindows": {
              "type": "List<@NonNull DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addAvailabilityTimeWindow(@NonNull DisplayTimeWindow)",
              "getter": "getAvailabilityTimeWindows()",
              "adderAll": "addAvailabilityTimeWindows(List<DisplayTimeWindow>)"
            },
            "posterImages": {
              "type": "List<@NonNull Image>",
              "requirement": "Optional",
              "adder": "addPosterImage(@NonNull Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "recommendationReason": {
              "type": "@NonNull RecommendationReason",
              "requirement": "Optional",
              "setter": "setRecommendationReason(@NonNull RecommendationReason)",
              "getter": "getRecommendationReason()"
            },
            "description": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setDescription(@NonNull String)",
              "getter": "getDescription()"
            },
            "entityId": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setEntityId(@NonNull String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setName(@NonNull String)",
              "getter": "getName()"
            },
            "callToActionText": {
              "requirement": "Optional",
              "setter": "setCallToActionText(@NonNull String)",
              "type": "@NonNull String",
              "getter": "getCallToActionText()"
            },
            "tags": {
              "requirement": "Optional",
              "adder": "addTag(@NonNull String)",
              "type": "List<@NonNull String>",
              "adderAll": "addTags(List<String>)",
              "getter": "getTags()"
            }
          }
        },
        "LiveStreamingVideoEntity": {
          "package": "com.google.android.engage.video.datamodel.LiveStreamingVideoEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "watchNextType": {
              "type": "@WatchNextType int",
              "requirement": "Optional",
              "setter": "setWatchNextType(@WatchNextType int)",
              "getter": "getWatchNextType()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "lastPlayBackPositionTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastPlayBackPositionTimeMillis(long)",
              "getter": "getLastPlayBackPositionTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "availabilityTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addAvailabilityTimeWindow(DisplayTimeWindow)",
              "getter": "getAvailabilityTimeWindows()"
            },
            "allAvailabilityTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllAvailabilityTimeWindows(DisplayTimeWindow)",
              "adderAll": "addAllAvailabilityTimeWindows(List<DisplayTimeWindow>)"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "startTimeEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setStartTimeEpochMillis(long)",
              "getter": "getStartTimeEpochMillis()"
            },
            "endTimeEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setEndTimeEpochMillis(long)",
              "getter": "getEndTimeEpochMillis()"
            },
            "broadcaster": {
              "type": "String",
              "requirement": "Required",
              "setter": "setBroadcaster(String)",
              "getter": "getBroadcaster()"
            },
            "viewCount": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setViewCount(String)",
              "getter": "getViewCount()"
            },
            "broadcasterIcon": {
              "type": "Image",
              "requirement": "Optional",
              "setter": "setBroadcasterIcon(Image)",
              "getter": "getBroadcasterIcon()"
            },
            "platformSpecificPlaybackUris": {
              "type": "List<PlatformSpecificUri>",
              "requirement": "Optional",
              "adder": "addPlatformSpecificPlaybackUri(PlatformSpecificUri)",
              "getter": "getPlatformSpecificPlaybackUris()",
              "adderAll": "addPlatformSpecificPlaybackUris(List<PlatformSpecificUri>)"
            },
            "description": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setDescription(@NonNull String)",
              "getter": "getDescription()"
            },
            "genres": {
              "type": "List<@NonNull String>",
              "requirement": "Optional",
              "adder": "addGenre(@NonNull String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "contentRatings": {
              "type": "List<@NonNull RatingSystem>",
              "requirement": "Optional",
              "adder": "addContentRating(@NonNull RatingSystem)",
              "getter": "getContentRatings()",
              "adderAll": "addContentRatings(List<RatingSystem>)"
            },
            "recommendationReason": {
              "type": "@NonNull RecommendationReason",
              "requirement": "Optional",
              "setter": "setRecommendationReason(@NonNull RecommendationReason)",
              "getter": "getRecommendationReason()"
            },
            "callToActionText": {
              "requirement": "Optional",
              "setter": "setCallToActionText(@NonNull String)",
              "type": "@NonNull String",
              "getter": "getCallToActionText()"
            },
            "tags": {
              "requirement": "Optional",
              "adder": "addTag(@NonNull String)",
              "type": "List<@NonNull String>",
              "adderAll": "addTags(List<String>)",
              "getter": "getTags()"
            }
          }
        },
        "LiveTvChannelEntity": {
          "package": "com.google.android.engage.video.datamodel.LiveTvChannelEntity",
          "fields": {
            "entityId": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setEntityId(@NonNull String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setName(@NonNull String)",
              "getter": "getName()"
            },
            "description": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setDescription(@NonNull String)",
              "getter": "getDescription()"
            },
            "logoImage": {
              "type": "@NonNull Image",
              "requirement": "Optional",
              "setter": "setLogoImage(@NonNull Image)",
              "getter": "getLogoImage()"
            },
            "contentRatings": {
              "type": "List<@NonNull RatingSystem>",
              "requirement": "Optional",
              "adder": "addContentRating(@NonNull RatingSystem)",
              "getter": "getContentRatings()",
              "adderAll": "addContentRatings(List<RatingSystem>)"
            },
            "platformSpecificPlaybackUris": {
              "type": "List<@NonNull PlatformSpecificUri>",
              "requirement": "Optional",
              "adder": "addPlatformSpecificPlaybackUri(@NonNull PlatformSpecificUri)",
              "getter": "getPlatformSpecificPlaybackUris()",
              "adderAll": "addPlatformSpecificPlaybackUris(List<PlatformSpecificUri>)"
            },
            "recommendationReason": {
              "type": "@NonNull RecommendationReason",
              "requirement": "Optional",
              "setter": "setRecommendationReason(@NonNull RecommendationReason)",
              "getter": "getRecommendationReason()"
            },
            "callToActionText": {
              "requirement": "Optional",
              "setter": "setCallToActionText(@NonNull String)",
              "type": "@NonNull String",
              "getter": "getCallToActionText()"
            },
            "tags": {
              "requirement": "Optional",
              "adder": "addTag(@NonNull String)",
              "type": "List<@NonNull String>",
              "adderAll": "addTags(List<String>)",
              "getter": "getTags()"
            }
          }
        },
        "VideoClipEntity": {
          "package": "com.google.android.engage.video.datamodel.VideoClipEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "watchNextType": {
              "type": "@WatchNextType int",
              "requirement": "Optional",
              "setter": "setWatchNextType(@WatchNextType int)",
              "getter": "getWatchNextType()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "lastPlayBackPositionTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastPlayBackPositionTimeMillis(long)",
              "getter": "getLastPlayBackPositionTimeMillis()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "availabilityTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addAvailabilityTimeWindow(DisplayTimeWindow)",
              "getter": "getAvailabilityTimeWindows()"
            },
            "allAvailabilityTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllAvailabilityTimeWindows(DisplayTimeWindow)",
              "adderAll": "addAllAvailabilityTimeWindows(List<DisplayTimeWindow>)"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "createdTimeEpochMillis": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setCreatedTimeEpochMillis(long)",
              "getter": "getCreatedTimeEpochMillis()"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setDurationMillis(long)",
              "getter": "getDurationMillis()"
            },
            "creator": {
              "type": "String",
              "requirement": "Required",
              "setter": "setCreator(String)",
              "getter": "getCreator()"
            },
            "creatorImage": {
              "type": "Image",
              "requirement": "Optional",
              "setter": "setCreatorImage(Image)",
              "getter": "getCreatorImage()"
            },
            "viewCount": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setViewCount(String)",
              "getter": "getViewCount()"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "platformSpecificPlaybackUris": {
              "type": "List<PlatformSpecificUri>",
              "requirement": "Optional",
              "adder": "addPlatformSpecificPlaybackUri(PlatformSpecificUri)",
              "getter": "getPlatformSpecificPlaybackUris()",
              "adderAll": "addPlatformSpecificPlaybackUris(List<PlatformSpecificUri>)"
            },
            "callToActionText": {
              "requirement": "Optional",
              "setter": "setCallToActionText(@NonNull String)",
              "type": "@NonNull String",
              "getter": "getCallToActionText()"
            },
            "tags": {
              "requirement": "Optional",
              "adder": "addTag(@NonNull String)",
              "type": "List<@NonNull String>",
              "adderAll": "addTags(List<String>)",
              "getter": "getTags()"
            }
          }
        }
      },
      "methods": {
        "isServiceAvailable": null,
        "publishRecommendationClusters": "PublishRecommendationClustersRequest",
        "publishFeaturedCluster": "PublishFeaturedClusterRequest",
        "publishContinuationCluster": "PublishContinuationClusterRequest",
        "publishSubscription": "PublishSubscriptionRequest",
        "publishUserAccountManagementRequest": "PublishUserAccountManagementRequest",
        "updatePublishStatus": "PublishStatusRequest",
        "deleteRecommendationsClusters": "DeleteClustersRequest",
        "deleteFeaturedCluster": "DeleteClustersRequest",
        "deleteContinuationCluster": "DeleteClustersRequest",
        "deleteSubscription": "DeleteClustersRequest",
        "deleteUserManagementCluster": "DeleteClustersRequest"
      },
      "intents": {}
    }