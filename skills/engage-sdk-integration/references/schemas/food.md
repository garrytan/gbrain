This file defines the schema for the FOOD vertical in the Engage SDK.

    {
      "client": "com.google.android.engage.food.service.AppEngageFoodClient",
      "clusterTypes": [
        "TYPE_RECOMMENDATION",
        "TYPE_FEATURED",
        "TYPE_FOOD_SHOPPING_CART",
        "TYPE_FOOD_SHOPPING_LIST",
        "TYPE_FOOD_REORDER"
      ],
      "entities": {
        "ProductEntity": {
          "package": "com.google.android.engage.food.datamodel.ProductEntity",
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
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()",
              "requiredFor": [
                "Required if strikethrough price is provided",
                "Mutually required with other rating fields"
              ]
            },
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
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
            "callout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setCallout(String)",
              "getter": "getCallout()"
            },
            "calloutFinePrint": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setCalloutFinePrint(String)",
              "getter": "getCalloutFinePrint()"
            },
            "price": {
              "type": "Price",
              "requirement": "Optional",
              "setter": "setPrice(Price)",
              "getter": "getPrice()",
              "requiredFor": [
                "Required if strikethrough price is provided"
              ]
            }
          }
        },
        "StoreEntity": {
          "package": "com.google.android.engage.food.datamodel.StoreEntity",
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
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()",
              "requiredFor": [
                "Mutually required with other rating fields"
              ]
            },
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "location": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setLocation(String)",
              "getter": "getLocation()"
            },
            "category": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setCategory(String)",
              "getter": "getCategory()"
            },
            "callout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setCallout(String)",
              "getter": "getCallout()"
            },
            "calloutFinePrint": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setCalloutFinePrint(String)",
              "getter": "getCalloutFinePrint()"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
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
            }
          }
        },
        "RestaurantReservationEntity": {
          "package": "com.google.android.engage.food.datamodel.RestaurantReservationEntity",
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
            "actionUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionUri(Uri)",
              "getter": "getActionUri()"
            },
            "title": {
              "type": "String",
              "requirement": "Required",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
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
            "location": {
              "type": "Address",
              "requirement": "Required",
              "setter": "setLocation(Address)",
              "getter": "getLocation()"
            },
            "reservationStartTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setReservationStartTime(Long)",
              "getter": "getReservationStartTime()"
            },
            "localizedReservationStartTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedReservationStartTime(LocalizedTimestamp)",
              "getter": "getLocalizedReservationStartTime()"
            },
            "tableSize": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setTableSize(Integer)",
              "getter": "getTableSize()"
            },
            "reservationId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setReservationId(String)",
              "getter": "getReservationId()"
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
            }
          }
        },
        "RecipeEntity": {
          "package": "com.google.android.engage.food.datamodel.RecipeEntity",
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
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Required",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()",
              "requiredFor": [
                "Mutually required with other rating fields"
              ]
            },
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "author": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setAuthor(String)",
              "getter": "getAuthor()"
            },
            "category": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setCategory(String)",
              "getter": "getCategory()"
            },
            "callout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setCallout(String)",
              "getter": "getCallout()"
            },
            "cookTime": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setCookTime(String)",
              "getter": "getCookTime()"
            },
            "description": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setDescription(String)",
              "getter": "getDescription()"
            }
          }
        }
      },
      "methods": {
        "isServiceAvailable": null,
        "publishRecommendationClusters": "PublishRecommendationClustersRequest",
        "publishFeaturedCluster": "PublishFeaturedClusterRequest",
        "publishFoodShoppingCarts": "PublishFoodShoppingCartsRequest",
        "publishReorderCluster": "PublishReorderClusterRequest",
        "publishFoodShoppingLists": "PublishFoodShoppingListsRequest",
        "publishUserAccountManagementRequest": "PublishUserAccountManagementRequest",
        "updatePublishStatus": "PublishStatusRequest",
        "deleteFoodShoppingCartCluster": "DeleteClustersRequest",
        "deleteFoodShoppingListCluster": "DeleteClustersRequest",
        "deleteReorderCluster": "DeleteClustersRequest",
        "deleteRecommendationsClusters": "DeleteClustersRequest",
        "deleteFeaturedCluster": "DeleteClustersRequest",
        "deleteUserManagementCluster": "DeleteClustersRequest"
      },
      "clusters": {
        "FoodReorderCluster": {
          "package": "com.google.android.engage.food.datamodel.FoodReorderCluster",
          "fields": {
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "actionText": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setActionText(String)",
              "getter": "getActionText()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Optional",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "itemLabels": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addItemLabel(String)",
              "getter": "getItemLabels()",
              "adderAll": "addItemLabels(List<String>)"
            },
            "numberOfItems": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setNumberOfItems(int)",
              "getter": "getNumberOfItems()"
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
            }
          }
        },
        "FoodShoppingList": {
          "package": "com.google.android.engage.food.datamodel.FoodShoppingList",
          "fields": {
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "actionText": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setActionText(String)",
              "getter": "getActionText()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Optional",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "itemLabels": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addItemLabel(String)",
              "getter": "getItemLabels()",
              "adderAll": "addItemLabels(List<String>)"
            },
            "numberOfItems": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setNumberOfItems(int)",
              "getter": "getNumberOfItems()"
            },
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "lastUserInteractionTimestampMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastUserInteractionTimestampMillis(long)",
              "getter": "getLastUserInteractionTimestampMillis()"
            }
          }
        },
        "FoodShoppingCart": {
          "package": "com.google.android.engage.food.datamodel.FoodShoppingCart",
          "fields": {
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "actionText": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setActionText(String)",
              "getter": "getActionText()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Optional",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "itemLabels": {
              "type": "List<List<String>>",
              "requirement": "Optional",
              "adder": "addItemLabel(String)",
              "getter": "getItemLabels()",
              "adderAll": "addItemLabels(List<String>)"
            },
            "numberOfItems": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setNumberOfItems(int)",
              "getter": "getNumberOfItems()"
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
            "lastUserInteractionTimestampMillis": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setLastUserInteractionTimestampMillis(long)",
              "getter": "getLastUserInteractionTimestampMillis()"
            }
          }
        }
      },
      "intents": {
        "ACTION_PUBLISH_FOOD_SHOPPING_CART": "com.google.android.engage.action.food.PUBLISH_FOOD_SHOPPING_CART",
        "ACTION_PUBLISH_FOOD_SHOPPING_LIST": "com.google.android.engage.action.food.PUBLISH_FOOD_SHOPPING_LIST",
        "ACTION_PUBLISH_REORDER_CLUSTER": "com.google.android.engage.action.food.PUBLISH_REORDER_CLUSTER"
      }
    }