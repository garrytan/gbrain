This file defines the schema for the SHOPPING vertical in the Engage SDK.

    {
      "client": "com.google.android.engage.shopping.service.AppEngageShoppingClient",
      "clusterTypes": [
        "TYPE_RECOMMENDATION",
        "TYPE_FEATURED",
        "TYPE_SHOPPING_CART",
        "TYPE_SHOPPING_LIST",
        "TYPE_SHOPPING_REORDER",
        "TYPE_SHOPPING_ORDER_TRACKING"
      ],
      "entities": {
        "ShoppingEntity": {
          "package": "com.google.android.engage.shopping.datamodel.ShoppingEntity",
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
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "title": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
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
            }
          }
        }
      },
      "methods": {
        "isServiceAvailable": null,
        "publishRecommendationClusters": "PublishRecommendationClustersRequest",
        "publishFeaturedCluster": "PublishFeaturedClusterRequest",
        "publishShoppingCart": "PublishShoppingCartClusterRequest",
        "publishShoppingLists": "PublishShoppingListsRequest",
        "publishShoppingReorderCluster": "PublishShoppingReorderClusterRequest",
        "publishShoppingOrderTrackingCluster": "PublishShoppingOrderTrackingClusterRequest",
        "publishUserAccountManagementRequest": "PublishUserAccountManagementRequest",
        "updatePublishStatus": "PublishStatusRequest",
        "deleteShoppingCartCluster": "DeleteClustersRequest",
        "deleteShoppingListCluster": "DeleteClustersRequest",
        "deleteReorderCluster": "DeleteClustersRequest",
        "deleteShoppingOrderTrackingCluster": "DeleteClustersRequest",
        "deleteRecommendationsClusters": "DeleteClustersRequest",
        "deleteFeaturedCluster": "DeleteClustersRequest",
        "deleteUserManagementCluster": "DeleteClustersRequest"
      },
      "clusters": {
        "ShoppingList": {
          "package": "com.google.android.engage.shopping.datamodel.ShoppingList",
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
        "ShoppingReorderCluster": {
          "package": "com.google.android.engage.shopping.datamodel.ShoppingReorderCluster",
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
        "ShoppingCart": {
          "package": "com.google.android.engage.shopping.datamodel.ShoppingCart",
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
        },
        "ShoppingOrderTrackingCluster": {
          "package": "com.google.android.engage.shopping.datamodel.ShoppingOrderTrackingCluster",
          "fields": {
            "title": {
              "type": "String",
              "requirement": "Required",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "posterImages": {
              "type": "List<Image>",
              "requirement": "Optional",
              "adder": "addPosterImage(Image)",
              "getter": "getPosterImages()",
              "adderAll": "addPosterImages(List<Image>)"
            },
            "status": {
              "type": "String",
              "requirement": "Required",
              "setter": "setStatus(String)",
              "getter": "getStatus()"
            },
            "orderTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setOrderTime(long)",
              "getter": "getOrderTime()"
            },
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "orderReadyTimeWindow": {
              "type": "OrderReadyTimeWindow",
              "requirement": "Optional",
              "setter": "setOrderReadyTimeWindow(OrderReadyTimeWindow)",
              "getter": "getOrderReadyTimeWindow()"
            },
            "numberOfItems": {
              "type": "Integer",
              "requirement": "Optional",
              "setter": "setNumberOfItems(Integer)",
              "getter": "getNumberOfItems()"
            },
            "orderDescription": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setOrderDescription(String)",
              "getter": "getOrderDescription()"
            },
            "subtitles": {
              "type": "List<String>",
              "requirement": "Optional",
              "adder": "addSubtitle(String)",
              "adderAll": "addSubtitles(List<String>)"
            },
            "orderValue": {
              "type": "Price",
              "requirement": "Optional",
              "setter": "setOrderValue(Price)",
              "getter": "getOrderValue()"
            },
            "shoppingOrderType": {
              "type": "@ShoppingOrderType int",
              "requirement": "Required",
              "setter": "setShoppingOrderType(@ShoppingOrderType int)",
              "getter": "getShoppingOrderType()"
            },
            "trackingId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTrackingId(String)",
              "getter": "getTrackingId()"
            }
          }
        }
      },
      "intents": {
        "ACTION_PUBLISH_SHOPPING_CART": "com.google.android.engage.action.shopping.PUBLISH_SHOPPING_CART",
        "ACTION_PUBLISH_SHOPPING_LIST": "com.google.android.engage.action.shopping.PUBLISH_SHOPPING_LIST",
        "ACTION_PUBLISH_REORDER_CLUSTER": "com.google.android.engage.action.shopping.PUBLISH_REORDER_CLUSTER",
        "ACTION_PUBLISH_ORDER_TRACKING_CLUSTER": "com.google.android.engage.action.shopping.PUBLISH_ORDER_TRACKING_CLUSTER"
      }
    }