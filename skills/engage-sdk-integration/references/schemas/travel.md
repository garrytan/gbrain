This file defines the schema for the TRAVEL vertical in the Engage SDK.

    {
      "client": "com.google.android.engage.travel.service.AppEngageTravelClient",
      "clusterTypes": [
        "TYPE_RECOMMENDATION",
        "TYPE_FEATURED",
        "TYPE_RESERVATION",
        "TYPE_CONTINUE_SEARCH"
      ],
      "entities": {
        "EventEntity": {
          "package": "com.google.android.engage.travel.datamodel.EventEntity",
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
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "title": {
              "type": "@NonNull String",
              "requirement": "Required",
              "setter": "setTitle(@NonNull String)",
              "getter": "getTitle()"
            },
            "startTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setStartTime(Long)",
              "getter": "getStartTime()"
            },
            "localizedStartTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedStartTime(LocalizedTimestamp)",
              "getter": "getLocalizedStartTime()"
            },
            "eventMode": {
              "type": "@EventMode int",
              "requirement": "Required",
              "setter": "setEventMode(@EventMode int)",
              "getter": "getEventMode()"
            },
            "locations": {
              "type": "Address",
              "requirement": "Required"
            },
            "endTime": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setEndTime(Long)",
              "getter": "getEndTime()"
            },
            "localizedEndTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Optional",
              "setter": "setLocalizedEndTime(LocalizedTimestamp)",
              "getter": "getLocalizedEndTime()"
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
            "badges": {
              "type": "List<Badge>",
              "requirement": "Optional",
              "adder": "addBadge(Badge)",
              "adderAll": "addBadges(List<Badge>)"
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
            "priceCallout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setPriceCallout(String)",
              "getter": "getPriceCallout()"
            },
            "contentCategories": {
              "type": "List<@EligibleContentCategory int>",
              "requirement": "Optional",
              "adder": "addContentCategory(@EligibleContentCategory int)",
              "adderAll": "addContentCategories(List<Integer>)"
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
            "location": {
              "requirement": "Required",
              "setter": "setLocation(Address)",
              "type": "Address",
              "getter": "getLocation()",
              "requiredFor": [
                "Required if strikethrough price is provided"
              ]
            }
          }
        },
        "LodgingEntity": {
          "package": "com.google.android.engage.travel.datamodel.LodgingEntity",
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
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "title": {
              "type": "String",
              "requirement": "Required",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "locations": {
              "type": "Address",
              "requirement": "Required"
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
            "priceCallout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setPriceCallout(String)",
              "getter": "getPriceCallout()"
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
            "availabilityTimeWindow": {
              "type": "AvailabilityTimeWindow",
              "requirement": "Optional",
              "setter": "setAvailabilityTimeWindow(AvailabilityTimeWindow)",
              "getter": "getAvailabilityTimeWindow()"
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()"
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
            "location": {
              "requirement": "Required",
              "setter": "setLocation(Address)",
              "type": "Address",
              "getter": "getLocation()",
              "requiredFor": [
                "Required if strikethrough price is provided"
              ]
            }
          }
        },
        "PointOfInterestEntity": {
          "package": "com.google.android.engage.travel.datamodel.PointOfInterestEntity",
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
            "actionLinkUri": {
              "type": "Uri",
              "requirement": "Required",
              "setter": "setActionLinkUri(Uri)",
              "getter": "getActionLinkUri()"
            },
            "title": {
              "type": "String",
              "requirement": "Required",
              "setter": "setTitle(String)",
              "getter": "getTitle()"
            },
            "locations": {
              "type": "Address",
              "requirement": "Required"
            },
            "availabilityTimeWindow": {
              "type": "AvailabilityTimeWindow",
              "requirement": "Optional",
              "setter": "setAvailabilityTimeWindow(AvailabilityTimeWindow)",
              "getter": "getAvailabilityTimeWindow()"
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
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()"
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
            "priceCallout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setPriceCallout(String)",
              "getter": "getPriceCallout()"
            },
            "contentCategories": {
              "type": "List<@EligibleContentCategory int>",
              "requirement": "Optional",
              "adder": "addContentCategory(@EligibleContentCategory int)",
              "adderAll": "addContentCategories(List<Integer>)"
            },
            "lastEngagementTime": {
              "type": "Instant",
              "requirement": "Optional",
              "setter": "setLastEngagementTime(Instant)",
              "getter": "getLastEngagementTime()",
              "requiredFor": [
                "ContinueSearchCluster"
              ]
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
            "location": {
              "requirement": "Required",
              "setter": "setLocation(Address)",
              "type": "Address",
              "getter": "getLocation()",
              "requiredFor": [
                "RecommendationCluster"
              ]
            }
          }
        },
        "LodgingReservationEntity": {
          "package": "com.google.android.engage.travel.datamodel.LodgingReservationEntity",
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
            "address": {
              "type": "Address",
              "requirement": "Required",
              "setter": "setAddress(Address)",
              "getter": "getAddress()"
            },
            "checkInTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setCheckInTime(long)",
              "getter": "getCheckInTime()"
            },
            "localizedCheckInTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedCheckInTime(LocalizedTimestamp)",
              "getter": "getLocalizedCheckInTime()"
            },
            "checkOutTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setCheckOutTime(long)",
              "getter": "getCheckOutTime()"
            },
            "localizedCheckOutTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedCheckOutTime(LocalizedTimestamp)",
              "getter": "getLocalizedCheckOutTime()"
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
            "priceCallout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setPriceCallout(String)",
              "getter": "getPriceCallout()"
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
        "EventReservationEntity": {
          "package": "com.google.android.engage.travel.datamodel.EventReservationEntity",
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
            "startTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setStartTime(Long)",
              "getter": "getStartTime()"
            },
            "localizedStartTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedStartTime(LocalizedTimestamp)",
              "getter": "getLocalizedStartTime()"
            },
            "eventMode": {
              "type": "@EventMode int",
              "requirement": "Required",
              "setter": "setEventMode(@EventMode int)",
              "getter": "getEventMode()"
            },
            "location": {
              "type": "Address",
              "requirement": "Required",
              "setter": "setLocation(Address)",
              "getter": "getLocation()"
            },
            "endTime": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setEndTime(Long)",
              "getter": "getEndTime()"
            },
            "localizedEndTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Optional",
              "setter": "setLocalizedEndTime(LocalizedTimestamp)",
              "getter": "getLocalizedEndTime()"
            },
            "serviceProvider": {
              "type": "ServiceProvider",
              "requirement": "Optional",
              "setter": "setServiceProvider(ServiceProvider)",
              "getter": "getServiceProvider()"
            },
            "badges": {
              "type": "List<Badge>",
              "requirement": "Optional",
              "adder": "addBadge(Badge)",
              "adderAll": "addBadges(List<Badge>)"
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
            "priceCallout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setPriceCallout(String)",
              "getter": "getPriceCallout()"
            },
            "rating": {
              "type": "Rating",
              "requirement": "Optional",
              "setter": "setRating(Rating)",
              "getter": "getRating()",
              "requiredFor": [
                "Required if strikethrough price is provided"
              ]
            },
            "contentCategories": {
              "type": "List<@EligibleContentCategory int>",
              "requirement": "Optional",
              "adder": "addContentCategory(@EligibleContentCategory int)",
              "adderAll": "addContentCategories(List<Integer>)"
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
        "TransportationReservationEntity": {
          "package": "com.google.android.engage.travel.datamodel.TransportationReservationEntity",
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
            "departureTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setDepartureTime(Long)",
              "getter": "getDepartureTime()"
            },
            "localizedDepartureTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedDepartureTime(LocalizedTimestamp)",
              "getter": "getLocalizedDepartureTime()"
            },
            "arrivalTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setArrivalTime(Long)",
              "getter": "getArrivalTime()"
            },
            "localizedArrivalTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedArrivalTime(LocalizedTimestamp)",
              "getter": "getLocalizedArrivalTime()"
            },
            "transportationType": {
              "type": "@TransportationType int",
              "requirement": "Required",
              "setter": "setTransportationType(@TransportationType int)",
              "getter": "getTransportationType()"
            },
            "departureLocation": {
              "type": "Address",
              "requirement": "Optional",
              "setter": "setDepartureLocation(Address)",
              "getter": "getDepartureLocation()"
            },
            "arrivalLocation": {
              "type": "Address",
              "requirement": "Optional",
              "setter": "setArrivalLocation(Address)",
              "getter": "getArrivalLocation()"
            },
            "serviceProvider": {
              "type": "ServiceProvider",
              "requirement": "Optional",
              "setter": "setServiceProvider(ServiceProvider)",
              "getter": "getServiceProvider()"
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
            "priceCallout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setPriceCallout(String)",
              "getter": "getPriceCallout()"
            },
            "transportationNumber": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setTransportationNumber(String)",
              "getter": "getTransportationNumber()"
            },
            "boardingTime": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setBoardingTime(Long)",
              "getter": "getBoardingTime()"
            },
            "localizedBoardingTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedBoardingTime(LocalizedTimestamp)",
              "getter": "getLocalizedBoardingTime()"
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
        "VehicleRentalReservationEntity": {
          "package": "com.google.android.engage.travel.datamodel.VehicleRentalReservationEntity",
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
            "pickupTime": {
              "type": "Long",
              "requirement": "Required",
              "setter": "setPickupTime(Long)",
              "getter": "getPickupTime()"
            },
            "localizedPickupTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Required",
              "setter": "setLocalizedPickupTime(LocalizedTimestamp)",
              "getter": "getLocalizedPickupTime()"
            },
            "returnTime": {
              "type": "Long",
              "requirement": "Optional",
              "setter": "setReturnTime(Long)",
              "getter": "getReturnTime()"
            },
            "localizedReturnTime": {
              "type": "LocalizedTimestamp",
              "requirement": "Optional",
              "setter": "setLocalizedReturnTime(LocalizedTimestamp)",
              "getter": "getLocalizedReturnTime()"
            },
            "pickupAddress": {
              "type": "Address",
              "requirement": "Optional",
              "setter": "setPickupAddress(Address)",
              "getter": "getPickupAddress()"
            },
            "returnAddress": {
              "type": "Address",
              "requirement": "Optional",
              "setter": "setReturnAddress(Address)",
              "getter": "getReturnAddress()"
            },
            "serviceProvider": {
              "type": "ServiceProvider",
              "requirement": "Optional",
              "setter": "setServiceProvider(ServiceProvider)",
              "getter": "getServiceProvider()"
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
            "priceCallout": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setPriceCallout(String)",
              "getter": "getPriceCallout()"
            },
            "confirmationId": {
              "type": "String",
              "requirement": "Optional",
              "setter": "setConfirmationId(String)",
              "getter": "getConfirmationId()"
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
        }
      },
      "methods": {
        "isServiceAvailable": null,
        "publishRecommendationClusters": "PublishRecommendationClustersRequest",
        "publishFeaturedCluster": "PublishFeaturedClusterRequest",
        "publishUserAccountManagementRequest": "PublishUserAccountManagementRequest",
        "updatePublishStatus": "PublishStatusRequest",
        "publishContinueSearchCluster": "PublishContinueSearchClusterRequest",
        "publishReservationCluster": "PublishReservationClusterRequest",
        "deleteRecommendationsClusters": "DeleteClustersRequest",
        "deleteFeaturedCluster": "DeleteClustersRequest",
        "deleteUserManagementCluster": "DeleteClustersRequest",
        "deleteContinueSearchCluster": "DeleteClustersRequest",
        "deleteReservationCluster": "DeleteClustersRequest"
      },
      "clusters": {
        "ContinueSearchCluster": {
          "package": "com.google.android.engage.travel.datamodel.ContinueSearchCluster",
          "fields": {
            "pointOfInterestEntities": {
              "type": "List<PointOfInterestEntity>",
              "requirement": "Required",
              "adder": "addPointOfInterestEntity(PointOfInterestEntity)"
            }
          }
        },
        "ReservationCluster": {
          "package": "com.google.android.engage.travel.datamodel.ReservationCluster",
          "fields": {
            "lodgingReservationEntities": {
              "type": "List<LodgingReservationEntity>",
              "requirement": "Optional",
              "adder": "addLodgingReservationEntity(LodgingReservationEntity)"
            },
            "vehicleRentalReservationEntities": {
              "type": "List<VehicleRentalReservationEntity>",
              "requirement": "Optional",
              "adder": "addVehicleRentalReservationEntity(VehicleRentalReservationEntity)"
            },
            "transportationReservationEntities": {
              "type": "List<TransportationReservationEntity>",
              "requirement": "Optional",
              "adder": "addTransportationReservationEntity(TransportationReservationEntity)"
            },
            "eventReservationEntities": {
              "type": "List<EventReservationEntity>",
              "requirement": "Optional",
              "adder": "addEventReservationEntity(EventReservationEntity)"
            },
            "restaurantReservationEntities": {
              "type": "List<RestaurantReservationEntity>",
              "requirement": "Optional",
              "adder": "addRestaurantReservationEntity(RestaurantReservationEntity)"
            }
          }
        }
      },
      "intents": {
        "ACTION_PUBLISH_CONTINUE_SEARCH_CLUSTER": "com.google.android.engage.action.travel.PUBLISH_CONTINUE_SEARCH",
        "ACTION_PUBLISH_RESERVATION_CLUSTER": "com.google.android.engage.action.travel.PUBLISH_RESERVATION"
      }
    }