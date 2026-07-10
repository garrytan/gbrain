This file defines the schema for the OTHER vertical in the Engage SDK.

    {
      "client": "com.google.android.engage.service.AppEngagePublishClient",
      "clusterTypes": [
        "TYPE_RECOMMENDATION",
        "TYPE_FEATURED"
      ],
      "entities": {
        "ArticleEntity": {
          "package": "com.google.android.engage.common.datamodel.ArticleEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "subtitleList": {
              "type": "List<String>",
              "requirement": "Optional"
            },
            "badgeList": {
              "type": "List<Badge>",
              "requirement": "Optional"
            },
            "contentCategoryList": {
              "type": "List<Integer>",
              "requirement": "Optional"
            },
            "lastEngagementTime": {
              "type": "Long",
              "requirement": "Optional",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "displayTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addDisplayTimeWindow(DisplayTimeWindow)",
              "getter": "getDisplayTimeWindows()"
            },
            "actionUri": {
              "requirement": "Required",
              "setter": "setActionUri(Uri)",
              "type": "Uri",
              "getter": "getActionUri()"
            },
            "subtitles": {
              "requirement": "Optional",
              "adder": "addSubtitle(String)",
              "type": "List<String>",
              "adderAll": "addSubtitles(List<String>)"
            },
            "badges": {
              "requirement": "Optional",
              "adder": "addBadge(Badge)",
              "type": "List<Badge>",
              "adderAll": "addBadges(List<Badge>)"
            },
            "contentCategories": {
              "requirement": "Optional",
              "adder": "addContentCategory(@EligibleContentCategory int)",
              "type": "List<@EligibleContentCategory int>",
              "adderAll": "addContentCategories(List<Integer>)"
            },
            "progressPercentage": {
              "requirement": "Required",
              "setter": "setProgressPercentage(int)",
              "type": "Integer",
              "getter": "getProgressPercentage()",
              "requiredFor": [
                "ContinuationCluster"
              ]
            },
            "lastEngagementTimestampMillis": {
              "requirement": "Required",
              "setter": "setLastEngagementTimestampMillis(long)",
              "type": "Long",
              "getter": "getLastEngagementTimestampMillis()"
            },
            "source": {
              "requirement": "Optional",
              "setter": "setSource(Badge)",
              "type": "Badge",
              "getter": "getSource()"
            },
            "lastContentPublishTimestampMillis": {
              "requirement": "Optional",
              "setter": "setLastContentPublishTimestampMillis(Long)",
              "type": "Long",
              "getter": "getLastContentPublishTimestampMillis()"
            },
            "allDisplayTimeWindows": {
              "requirement": "Optional",
              "adder": "addAllDisplayTimeWindow(DisplayTimeWindow)",
              "type": "List<List<DisplayTimeWindow>>",
              "adderAll": "addAllDisplayTimeWindow(List<DisplayTimeWindow>)"
            }
          }
        },
        "GenericFeaturedEntity": {
          "package": "com.google.android.engage.common.datamodel.GenericFeaturedEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "actionUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionUri(Uri)",
              "getter": "getActionUri()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "subtitleList": {
              "type": "List<String>",
              "requirement": "Optional"
            },
            "badgeList": {
              "type": "List<Badge>",
              "requirement": "Optional"
            },
            "contentCategoryList": {
              "type": "List<Integer>",
              "requirement": "Optional"
            },
            "displayTimeWindows": {
              "type": "List<DisplayTimeWindow>",
              "requirement": "Optional",
              "adder": "addDisplayTimeWindow(DisplayTimeWindow)",
              "getter": "getDisplayTimeWindows()"
            },
            "subtitles": {
              "requirement": "Optional",
              "adder": "addSubtitle(String)",
              "type": "List<String>",
              "adderAll": "addSubtitles(List<String>)"
            },
            "badges": {
              "requirement": "Optional",
              "adder": "addBadge(Badge)",
              "type": "List<Badge>",
              "adderAll": "addBadges(List<Badge>)"
            },
            "contentCategories": {
              "requirement": "Optional",
              "adder": "addContentCategory(@EligibleContentCategory int)",
              "type": "List<@EligibleContentCategory int>",
              "adderAll": "addContentCategories(List<Integer>)"
            },
            "allDisplayTimeWindows": {
              "requirement": "Optional",
              "adder": "addAllDisplayTimeWindow(DisplayTimeWindow)",
              "type": "List<List<DisplayTimeWindow>>",
              "adderAll": "addAllDisplayTimeWindow(List<DisplayTimeWindow>)"
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