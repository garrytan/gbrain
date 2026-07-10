This file defines the request structures for publishing various data models in
the Engage SDK.

    {
      "PublishRecommendationClustersRequest": {
        "package": "com.google.android.engage.service.PublishRecommendationClustersRequest",
        "fields": {
          "recommendationClusters": {
            "type": "List<RecommendationCluster>",
            "requirement": "Required",
            "adder": "addRecommendationCluster(RecommendationCluster)",
            "getter": "getRecommendationClusters()"
          },
          "accountProfile": {
            "type": "@NonNull AccountProfile",
            "requirement": "Optional",
            "setter": "setAccountProfile(@NonNull AccountProfile)",
            "getter": "getAccountProfile()"
          },
          "syncAcrossDevices": {
            "type": "Boolean",
            "requirement": "Optional",
            "setter": "setSyncAcrossDevices(boolean)",
            "getter": "getSyncAcrossDevices()"
          }
        }
      },
      "PublishFeaturedClusterRequest": {
        "package": "com.google.android.engage.service.PublishFeaturedClusterRequest",
        "fields": {
          "featuredCluster": {
            "type": "FeaturedCluster",
            "requirement": "Required",
            "setter": "setFeaturedCluster(FeaturedCluster)",
            "getter": "getFeaturedCluster()"
          }
        }
      },
      "DeleteClustersRequest": {
        "package": "com.google.android.engage.service.DeleteClustersRequest",
        "fields": {
          "clusterTypes": {
            "type": "List<@ClusterType int>",
            "requirement": "Optional",
            "adder": "addClusterType(@ClusterType int)"
          },
          "deleteReason": {
            "type": "@DeleteReason int",
            "requirement": "Optional",
            "setter": "setDeleteReason(@DeleteReason int)",
            "getter": "getDeleteReason()"
          },
          "accountProfile": {
            "requirement": "Optional",
            "setter": "setAccountProfile(AccountProfile)",
            "type": "AccountProfile",
            "getter": "getAccountProfile()"
          },
          "syncAcrossDevices": {
            "requirement": "Optional",
            "setter": "setSyncAcrossDevices(boolean)",
            "type": "Boolean",
            "getter": "getSyncAcrossDevices()"
          }
        }
      },
      "PublishContinuationClusterRequest": {
        "package": "com.google.android.engage.service.PublishContinuationClusterRequest",
        "fields": {
          "continuationCluster": {
            "type": "ContinuationCluster",
            "requirement": "Required",
            "setter": "setContinuationCluster(ContinuationCluster)",
            "getter": "getContinuationCluster()"
          }
        }
      },
      "PublishStatusRequest": {
        "package": "com.google.android.engage.service.PublishStatusRequest",
        "fields": {
          "statusCode": {
            "type": "@AppEngagePublishStatusCode int",
            "requirement": "Required",
            "setter": "setStatusCode(@AppEngagePublishStatusCode int)",
            "getter": "getStatusCode()"
          }
        }
      },
      "PublishSubscriptionRequest": {
        "package": "com.google.android.engage.service.PublishSubscriptionRequest",
        "fields": {
          "subscriptionClusters": {
            "type": "List<SubscriptionCluster>",
            "requirement": "Required"
          },
          "accountProfile": {
            "type": "AccountProfile",
            "requirement": "Required",
            "setter": "setAccountProfile(AccountProfile)",
            "getter": "getAccountProfile()"
          },
          "subscription": {
            "requirement": "Required",
            "setter": "setSubscription(SubscriptionEntity)",
            "type": "SubscriptionEntity",
            "getter": "getSubscription()"
          }
        }
      },
      "PublishUserAccountManagementRequest": {
        "package": "com.google.android.engage.service.PublishUserAccountManagementRequest",
        "fields": {
          "actionUri": {
            "type": "Uri",
            "requirement": "Required"
          },
          "signInCardEntity": {
            "type": "SignInCardEntity",
            "requirement": "Required",
            "setter": "setSignInCardEntity(SignInCardEntity)"
          },
          "userSettingsCardEntity": {
            "requirement": "Required",
            "setter": "setUserSettingsCardEntity(UserSettingsCardEntity)",
            "type": "UserSettingsCardEntity"
          }
        }
      },
      "PublishShoppingCartClusterRequest": {
        "package": "com.google.android.engage.shopping.service.PublishShoppingCartClusterRequest",
        "fields": {
          "shoppingCart": {
            "requirement": "Required",
            "setter": "setShoppingCart(ShoppingCart)",
            "type": "ShoppingCart",
            "getter": "getShoppingCart()"
          }
        }
      },
      "PublishShoppingListsRequest": {
        "package": "com.google.android.engage.shopping.service.PublishShoppingListsRequest",
        "fields": {
          "shoppingLists": {
            "type": "List<ShoppingList>",
            "requirement": "Optional",
            "adder": "addShoppingList(ShoppingList)",
            "getter": "getShoppingLists()",
            "adderAll": "addShoppingLists(List<ShoppingList>)"
          }
        }
      },
      "PublishShoppingOrderTrackingClusterRequest": {
        "package": "com.google.android.engage.shopping.service.PublishShoppingOrderTrackingClusterRequest",
        "fields": {
          "shoppingOrderTrackingCluster": {
            "type": "ShoppingOrderTrackingCluster",
            "requirement": "Required",
            "setter": "setShoppingOrderTrackingCluster(ShoppingOrderTrackingCluster)",
            "getter": "getShoppingOrderTrackingCluster()"
          }
        }
      },
      "PublishShoppingReorderClusterRequest": {
        "package": "com.google.android.engage.shopping.service.PublishShoppingReorderClusterRequest",
        "fields": {
          "reorderCluster": {
            "type": "ShoppingReorderCluster",
            "requirement": "Required",
            "setter": "setReorderCluster(ShoppingReorderCluster)",
            "getter": "getReorderCluster()"
          }
        }
      },
      "PublishFoodShoppingCartsRequest": {
        "package": "com.google.android.engage.food.service.PublishFoodShoppingCartsRequest",
        "fields": {
          "foodShoppingCarts": {
            "type": "List<FoodShoppingCart>",
            "requirement": "Optional",
            "adder": "addFoodShoppingCart(FoodShoppingCart)",
            "getter": "getFoodShoppingCarts()",
            "adderAll": "addFoodShoppingCarts(List<FoodShoppingCart>)"
          }
        }
      },
      "PublishFoodShoppingListsRequest": {
        "package": "com.google.android.engage.food.service.PublishFoodShoppingListsRequest",
        "fields": {
          "foodShoppingLists": {
            "type": "List<FoodShoppingList>",
            "requirement": "Optional",
            "adder": "addFoodShoppingList(FoodShoppingList)",
            "getter": "getFoodShoppingLists()",
            "adderAll": "addFoodShoppingLists(List<FoodShoppingList>)"
          }
        }
      },
      "PublishReorderClusterRequest": {
        "package": "com.google.android.engage.food.service.PublishReorderClusterRequest",
        "fields": {
          "reorderCluster": {
            "requirement": "Required",
            "setter": "setReorderCluster(FoodReorderCluster)",
            "type": "FoodReorderCluster",
            "getter": "getReorderCluster()"
          }
        }
      },
      "PublishContinueSearchClusterRequest": {
        "package": "com.google.android.engage.travel.service.PublishContinueSearchClusterRequest",
        "fields": {
          "continueSearchCluster": {
            "type": "ContinueSearchCluster",
            "requirement": "Required",
            "setter": "setContinueSearchCluster(ContinueSearchCluster)",
            "getter": "getContinueSearchCluster()"
          }
        }
      },
      "PublishReservationClusterRequest": {
        "package": "com.google.android.engage.travel.service.PublishReservationClusterRequest",
        "fields": {
          "reservationCluster": {
            "type": "ReservationCluster",
            "requirement": "Required",
            "setter": "setReservationCluster(ReservationCluster)",
            "getter": "getReservationCluster()"
          }
        }
      }
    }