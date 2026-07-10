This file defines the schema for the SOCIAL vertical in the Engage SDK.

    {
      "client": "com.google.android.engage.social.service.AppEngageSocialClient",
      "clusterTypes": [
        "TYPE_RECOMMENDATION",
        "TYPE_FEATURED"
      ],
      "entities": {
        "SocialPostEntity": {
          "package": "com.google.android.engage.social.datamodel.SocialPostEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
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
            "genericPost": {
              "type": "GenericPost",
              "requirement": "Required",
              "setter": "setGenericPost(GenericPost)",
              "getter": "getGenericPost()"
            },
            "profile": {
              "type": "Profile",
              "requirement": "Optional",
              "setter": "setProfile(Profile)",
              "getter": "getProfile()"
            },
            "interactions": {
              "type": "List<Interaction>",
              "requirement": "Optional",
              "adder": "addInteraction(Interaction)",
              "getter": "getInteractions()"
            },
            "allInteractions": {
              "type": "List<List<Interaction>>",
              "requirement": "Optional",
              "adder": "addAllInteraction(Interaction)",
              "adderAll": "addAllInteraction(List<Interaction>)"
            }
          }
        },
        "PortraitMediaEntity": {
          "package": "com.google.android.engage.social.datamodel.PortraitMediaEntity",
          "fields": {
            "entityId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setEntityId(String)",
              "getter": "getEntityId()"
            },
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
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
            "portraitMediaPost": {
              "type": "PortraitMediaPost",
              "requirement": "Required",
              "setter": "setPortraitMediaPost(PortraitMediaPost)",
              "getter": "getPortraitMediaPost()"
            },
            "profile": {
              "type": "Profile",
              "requirement": "Optional",
              "setter": "setProfile(Profile)",
              "getter": "getProfile()"
            },
            "interactions": {
              "type": "List<List<Interaction>>",
              "requirement": "Optional",
              "adder": "addInteractions(Interaction)",
              "getter": "getInteractions()",
              "adderAll": "addInteractions(List<Interaction>)"
            },
            "recommendationReason": {
              "type": "@NonNull RecommendationReason",
              "requirement": "Optional",
              "setter": "setRecommendationReason(@NonNull RecommendationReason)",
              "getter": "getRecommendationReason()"
            },
            "platformSpecificPlaybackUris": {
              "type": "List<@NonNull PlatformSpecificUri>",
              "requirement": "Optional",
              "adder": "addPlatformSpecificPlaybackUri(@NonNull PlatformSpecificUri)",
              "getter": "getPlatformSpecificPlaybackUris()",
              "adderAll": "addPlatformSpecificPlaybackUris(List<PlatformSpecificUri>)"
            },
            "commentsSummary": {
              "type": "@NonNull String",
              "requirement": "Optional",
              "setter": "setCommentsSummary(@NonNull String)",
              "getter": "getCommentsSummary()"
            },
            "interaction": {
              "requirement": "Optional",
              "setter": "setInteraction(Interaction)",
              "type": "Interaction",
              "getter": "getInteraction()"
            }
          }
        },
        "PersonEntity": {
          "package": "com.google.android.engage.social.datamodel.PersonEntity",
          "fields": {
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
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
            "profile": {
              "type": "Profile",
              "requirement": "Required",
              "setter": "setProfile(Profile)",
              "getter": "getProfile()"
            },
            "headerImage": {
              "type": "Image",
              "requirement": "Optional",
              "setter": "setHeaderImage(Image)",
              "getter": "getHeaderImage()"
            },
            "popularity": {
              "type": "Popularity",
              "requirement": "Optional",
              "setter": "setPopularity(Popularity)",
              "getter": "getPopularity()"
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()"
            },
            "locations": {
              "type": "Address",
              "requirement": "Optional"
            },
            "badges": {
              "type": "List<Badge>",
              "requirement": "Optional",
              "adder": "addBadge(Badge)",
              "adderAll": "addBadges(List<Badge>)"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            },
            "subtitles": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addSubtitle(String)",
              "adderAll": "addSubtitles(List<String>)"
            },
            "contentCategories": {
              "type": "List<@EligibleContentCategory int>",
              "requirement": "Optional",
              "adder": "addContentCategory(@EligibleContentCategory int)",
              "adderAll": "addContentCategories(List<Integer>)"
            },
            "location": {
              "requirement": "Optional",
              "setter": "setLocation(Address)",
              "type": "Address",
              "getter": "getLocation()"
            }
          }
        }
      },
      "methods": {
        "isServiceAvailable": null,
        "publishRecommendationClusters": "PublishRecommendationClustersRequest",
        "publishUserAccountManagementRequest": "PublishUserAccountManagementRequest",
        "updatePublishStatus": "PublishStatusRequest",
        "deleteUserManagementCluster": "DeleteClustersRequest",
        "deleteRecommendationsClusters": "DeleteClustersRequest"
      },
      "intents": {}
    }