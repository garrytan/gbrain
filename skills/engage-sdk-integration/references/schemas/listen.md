This file defines the schema for the LISTEN vertical in the Engage SDK.

    {
      "client": "com.google.android.engage.service.AppEngagePublishClient",
      "clusterTypes": [
        "TYPE_RECOMMENDATION",
        "TYPE_FEATURED",
        "TYPE_CONTINUATION"
      ],
      "entities": {
        "MusicAlbumEntity": {
          "package": "com.google.android.engage.audio.datamodel.MusicAlbumEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
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
            "songsCount": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setSongsCount(int)",
              "getter": "getSongsCount()"
            },
            "releaseDateEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setReleaseDateEpochMillis(long)",
              "getter": "getReleaseDateEpochMillis()"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Optional",
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
            "musicLabels": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addMusicLabel(String)",
              "getter": "getMusicLabels()",
              "adderAll": "addMusicLabels(List<String>)"
            },
            "artists": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addArtist(String)",
              "getter": "getArtists()",
              "adderAll": "addArtists(List<String>)"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "explicitContent": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setExplicitContent(boolean)",
              "getter": "isExplicitContent()"
            },
            "musicAlbumType": {
              "type": "@MusicAlbumType int",
              "requirement": "Optional",
              "setter": "setMusicAlbumType(@MusicAlbumType int)",
              "getter": "getMusicAlbumType()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()"
            },
            "progressPercentComplete": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setProgressPercentComplete(int)",
              "getter": "getProgressPercentComplete()"
            }
          }
        },
        "MusicTrackEntity": {
          "package": "com.google.android.engage.audio.datamodel.MusicTrackEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setDurationMillis(long)",
              "getter": "getDurationMillis()"
            },
            "infoPageUri": {
              "type": "Uri",
              "requirement": "Optional",
              "setter": "setInfoPageUri(Uri)",
              "getter": "getInfoPageUri()"
            },
            "album": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setAlbum(String)",
              "getter": "getAlbum()"
            },
            "artists": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addArtist(String)",
              "getter": "getArtists()",
              "adderAll": "addArtists(List<String>)"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "explicitContent": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setExplicitContent(boolean)",
              "getter": "isExplicitContent()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()"
            },
            "progressPercentComplete": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setProgressPercentComplete(int)",
              "getter": "getProgressPercentComplete()"
            }
          }
        },
        "PodcastEpisodeEntity": {
          "package": "com.google.android.engage.audio.datamodel.PodcastEpisodeEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
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
            "episodeIndex": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setEpisodeIndex(int)",
              "getter": "getEpisodeIndex()"
            },
            "podcastSeriesTitle": {
              "type": "String",
              "requirement": "Required",
              "setter": "setPodcastSeriesTitle(String)",
              "getter": "getPodcastSeriesTitle()"
            },
            "productionName": {
              "type": "String",
              "requirement": "Required",
              "setter": "setProductionName(String)",
              "getter": "getProductionName()"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setDurationMillis(long)",
              "getter": "getDurationMillis()"
            },
            "publishDateEpochMillis": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setPublishDateEpochMillis(long)",
              "getter": "getPublishDateEpochMillis()"
            },
            "genres": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "hosts": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addHost(String)",
              "getter": "getHosts()",
              "adderAll": "addHosts(List<String>)"
            },
            "explicitContent": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setExplicitContent(boolean)",
              "getter": "isExplicitContent()"
            },
            "listenNextType": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setListenNextType(int)",
              "getter": "getListenNextType()"
            },
            "videoPodcast": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setVideoPodcast(boolean)",
              "getter": "isVideoPodcast()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()"
            },
            "progressPercentComplete": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setProgressPercentComplete(int)",
              "getter": "getProgressPercentComplete()"
            }
          }
        },
        "MusicVideoEntity": {
          "package": "com.google.android.engage.audio.datamodel.MusicVideoEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setDurationMillis(long)",
              "getter": "getDurationMillis()"
            },
            "infoPageUri": {
              "type": "Uri",
              "requirement": "Optional",
              "setter": "setInfoPageUri(Uri)",
              "getter": "getInfoPageUri()"
            },
            "viewCount": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setViewCount(String)",
              "getter": "getViewCount()"
            },
            "artists": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addArtist(String)",
              "getter": "getArtists()",
              "adderAll": "addArtists(List<String>)"
            },
            "contentRatings": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addContentRating(String)",
              "getter": "getContentRatings()",
              "adderAll": "addContentRatings(List<String>)"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "explicitContent": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setExplicitContent(boolean)",
              "getter": "isExplicitContent()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()"
            },
            "progressPercentComplete": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setProgressPercentComplete(int)",
              "getter": "getProgressPercentComplete()"
            }
          }
        },
        "LiveRadioStationEntity": {
          "package": "com.google.android.engage.audio.datamodel.LiveRadioStationEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()"
            },
            "radioFrequencyId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setRadioFrequencyId(String)",
              "getter": "getRadioFrequencyId()"
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
            "showTitle": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setShowTitle(String)",
              "getter": "getShowTitle()"
            },
            "hosts": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addHost(String)",
              "getter": "getHosts()",
              "adderAll": "addHosts(List<String>)"
            }
          }
        },
        "GenericAudioEntity": {
          "package": "com.google.android.engage.audio.datamodel.GenericAudioEntity",
          "fields": {
            "entityId": {
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "type": "String",
              "getter": "getEntityId()"
            },
            "name": {
              "requirement": "Required",
              "setter": "setName(String)",
              "type": "String",
              "getter": "getName()"
            },
            "posterImages": {
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "type": "List<Image>",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "actionUri": {
              "requirement": "Required",
              "setter": "setActionUri(Uri)",
              "type": "Uri",
              "getter": "getActionUri()"
            },
            "downloadedOnDevice": {
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "type": "Boolean",
              "getter": "isDownloadedOnDevice()"
            },
            "explicitContent": {
              "requirement": "Required",
              "setter": "setExplicitContent(boolean)",
              "type": "Boolean",
              "getter": "isExplicitContent()"
            },
            "progressPercentComplete": {
              "requirement": "Optional",
              "setter": "setProgressPercentComplete(int)",
              "type": "Integer",
              "getter": "getProgressPercentComplete()"
            },
            "lastEngagementTimeMillis": {
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "type": "Long",
              "getter": "getLastEngagementTimeMillis()"
            },
            "listenNextType": {
              "requirement": "Optional",
              "setter": "setListenNextType(@ListenNextType int)",
              "type": "@ListenNextType int",
              "getter": "getListenNextType()"
            },
            "price": {
              "requirement": "Optional",
              "setter": "setPrice(Price)",
              "type": "Price",
              "getter": "getPrice()"
            },
            "rating": {
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "type": "Rating",
              "getter": "getRating()"
            },
            "callout": {
              "requirement": "Optional",
              "setter": "setCallout(String)",
              "type": "String",
              "getter": "getCallout()"
            },
            "calloutFinePrint": {
              "requirement": "Optional",
              "setter": "setCalloutFinePrint(String)",
              "type": "String",
              "getter": "getCalloutFinePrint()"
            },
            "displayTimeWindows": {
              "requirement": "Optional",
              "adder": "addDisplayTimeWindow(DisplayTimeWindow)",
              "type": "List<DisplayTimeWindow>",
              "getter": "getDisplayTimeWindows()"
            },
            "allDisplayTimeWindows": {
              "requirement": "Optional",
              "adder": "addAllDisplayTimeWindow(DisplayTimeWindow)",
              "type": "List<List<DisplayTimeWindow>>",
              "adderAll": "addAllDisplayTimeWindow(List<DisplayTimeWindow>)"
            },
            "isBook": {
              "requirement": "Optional",
              "setter": "setIsBook(boolean)",
              "type": "Boolean",
              "getter": "isBook()"
            },
            "isTalk": {
              "requirement": "Optional",
              "setter": "setIsTalk(Boolean)",
              "type": "Boolean",
              "getter": "isTalk()"
            },
            "isVideoSupported": {
              "requirement": "Optional",
              "setter": "setIsVideoSupported(Boolean)",
              "type": "Boolean",
              "getter": "isVideoSupported()"
            },
            "isArtist": {
              "requirement": "Optional",
              "setter": "setIsArtist(Boolean)",
              "type": "Boolean",
              "getter": "isArtist()"
            },
            "subtitles": {
              "requirement": "Optional",
              "adder": "addSubtitle(String)",
              "type": "List<String>",
              "adderAll": "addSubtitles(List<String>)"
            }
          }
        },
        "PodcastSeriesEntity": {
          "package": "com.google.android.engage.audio.datamodel.PodcastSeriesEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
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
            "episodeCount": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setEpisodeCount(int)",
              "getter": "getEpisodeCount()"
            },
            "productionName": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setProductionName(String)",
              "getter": "getProductionName()"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "genres": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "hosts": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addHost(String)",
              "getter": "getHosts()",
              "adderAll": "addHosts(List<String>)"
            },
            "explicitContent": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setExplicitContent(boolean)",
              "getter": "isExplicitContent()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()"
            }
          }
        },
        "MusicArtistEntity": {
          "package": "com.google.android.engage.audio.datamodel.MusicArtistEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
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
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()"
            }
          }
        },
        "PlaylistEntity": {
          "package": "com.google.android.engage.audio.datamodel.PlaylistEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "name": {
              "type": "String",
              "requirement": "Required",
              "setter": "setName(String)",
              "getter": "getName()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "playBackUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setPlayBackUri(Uri)",
              "getter": "getPlayBackUri()"
            },
            "songsCount": {
              "type": "Integer",
              "requirement": "Required",
              "setter": "setSongsCount(int)",
              "getter": "getSongsCount()"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setDurationMillis(long)",
              "getter": "getDurationMillis()"
            },
            "infoPageUri": {
              "type": "Uri",
              "requirement": "Optional",
              "setter": "setInfoPageUri(Uri)",
              "getter": "getInfoPageUri()"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "explicitContent": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setExplicitContent(boolean)",
              "getter": "isExplicitContent()"
            },
            "lastEngagementTimeMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastEngagementTimeMillis(long)",
              "getter": "getLastEngagementTimeMillis()"
            },
            "progressPercentComplete": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setProgressPercentComplete(int)",
              "getter": "getProgressPercentComplete()"
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