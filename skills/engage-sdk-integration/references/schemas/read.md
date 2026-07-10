This file defines the schema for the READ vertical in the Engage SDK.

    {
      "client": "com.google.android.engage.service.AppEngagePublishClient",
      "clusterTypes": [
        "TYPE_RECOMMENDATION",
        "TYPE_FEATURED",
        "TYPE_CONTINUATION"
      ],
      "entities": {
        "EbookEntity": {
          "package": "com.google.android.engage.books.datamodel.EbookEntity",
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
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "authors": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addAuthor(String)",
              "getter": "getAuthors()",
              "adderAll": "addAuthors(List<String>)"
            },
            "publishDateEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setPublishDateEpochMillis(long)",
              "getter": "getPublishDateEpochMillis()"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "pageCount": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setPageCount(int)",
              "getter": "getPageCount()"
            },
            "price": {
              "type": "Price",
              "requirement": "Optional",
              "setter": "setPrice(Price)",
              "getter": "getPrice()"
            },
            "genres": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
            },
            "seriesName": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setSeriesName(String)",
              "getter": "getSeriesName()"
            },
            "seriesUnitIndex": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setSeriesUnitIndex(Integer)",
              "getter": "getSeriesUnitIndex()"
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
            "progressPercentComplete": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setProgressPercentComplete(int)",
              "getter": "getProgressPercentComplete()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()"
            },
            "availability": {
              "type": "@ContentAvailability int",
              "requirement": "Optional",
              "setter": "setAvailability(@ContentAvailability int)",
              "getter": "getAvailability()"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "displayTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addDisplayTimeWindow(DisplayTimeWindow)",
              "getter": "getDisplayTimeWindows()"
            },
            "allDisplayTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllDisplayTimeWindow(DisplayTimeWindow)",
              "adderAll": "addAllDisplayTimeWindow(List<DisplayTimeWindow>)"
            },
            "continueBookType": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setContinueBookType(int)",
              "getter": "getContinueBookType()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            }
          }
        },
        "BookSeriesEntity": {
          "package": "com.google.android.engage.books.datamodel.BookSeriesEntity",
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
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "bookCount": {
              "type": "Integer",
              "requirement": "Required",
              "setter": "setBookCount(int)",
              "getter": "getBookCount()"
            },
            "authors": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addAuthor(String)",
              "getter": "getAuthors()",
              "adderAll": "addAuthors(List<String>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "genres": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
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
            "progressPercentComplete": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setProgressPercentComplete(int)",
              "getter": "getProgressPercentComplete()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()"
            },
            "availability": {
              "type": "@ContentAvailability int",
              "requirement": "Optional",
              "setter": "setAvailability(@ContentAvailability int)",
              "getter": "getAvailability()"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "displayTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addDisplayTimeWindow(DisplayTimeWindow)",
              "getter": "getDisplayTimeWindows()"
            },
            "allDisplayTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllDisplayTimeWindow(DisplayTimeWindow)",
              "adderAll": "addAllDisplayTimeWindow(List<DisplayTimeWindow>)"
            },
            "continueBookType": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setContinueBookType(int)",
              "getter": "getContinueBookType()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            }
          }
        },
        "AudiobookEntity": {
          "package": "com.google.android.engage.books.datamodel.AudiobookEntity",
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
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()"
            },
            "availability": {
              "type": "@ContentAvailability int",
              "requirement": "Optional",
              "setter": "setAvailability(@ContentAvailability int)",
              "getter": "getAvailability()"
            },
            "downloadedOnDevice": {
              "type": "Boolean",
              "requirement": "Optional",
              "setter": "setDownloadedOnDevice(boolean)",
              "getter": "isDownloadedOnDevice()"
            },
            "displayTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addDisplayTimeWindow(DisplayTimeWindow)",
              "getter": "getDisplayTimeWindows()"
            },
            "allDisplayTimeWindows": {
              "type": "List<List<DisplayTimeWindow>>",
              "requirement": "Optional",
              "adder": "addAllDisplayTimeWindow(DisplayTimeWindow)",
              "adderAll": "addAllDisplayTimeWindow(List<DisplayTimeWindow>)"
            },
            "authors": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addAuthor(String)",
              "getter": "getAuthors()",
              "adderAll": "addAuthors(List<String>)"
            },
            "narrators": {
              "type": "List<String>",
              "requirement": "Required",
              "adder": "addNarrator(String)",
              "getter": "getNarrators()",
              "adderAll": "addNarrators(List<String>)"
            },
            "publishDateEpochMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setPublishDateEpochMillis(long)",
              "getter": "getPublishDateEpochMillis()"
            },
            "durationMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setDurationMillis(long)",
              "getter": "getDurationMillis()"
            },
            "price": {
              "type": "Price",
              "requirement": "Optional",
              "setter": "setPrice(Price)",
              "getter": "getPrice()"
            },
            "seriesName": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setSeriesName(String)",
              "getter": "getSeriesName()"
            },
            "seriesUnitIndex": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setSeriesUnitIndex(Integer)",
              "getter": "getSeriesUnitIndex()"
            },
            "genres": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addGenre(String)",
              "getter": "getGenres()",
              "adderAll": "addGenres(List<String>)"
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
            },
            "continueBookType": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setContinueBookType(int)",
              "getter": "getContinueBookType()"
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