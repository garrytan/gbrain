Boost app engagement by reaching your users where they are. Integrate Engage SDK
to deliver personalized recommendations and continuation content directly to
users across multiple on-device surfaces, like
**[Collections](https://android-developers.googleblog.com/2024/07/introducing-collections-powered-by-engage-sdk.html)** , **[Entertainment
Space](https://blog.google/products/android/entertainment-space/)** , and the Play Store. The integration adds
less than 50 KB (compressed) to the average APK and takes most apps about a
week of developer time. Learn more at our **[business
site](http://play.google.com/console/about/programs/EngageSDK)**.

This guide contains instructions for developer partners to deliver health and
fitness content to Engage content surfaces.

## Integration detail

### Terminology

This integration includes the following three cluster types: **Recommendation** ,
**Featured** , and **Continuation**.

- **Recommendation** clusters show personalized health and fitness suggestions
  from an individual developer partner. These recommendations can be
  personalized to the user or generalized (for example, trending fitness \&
  health). Use these to surface articles or people related to health and
  fitness.

  - A Recommendation cluster can be made of `ArticleEntity`, `PersonEntity`, or `EventEntity` but not a mix of different entity types.

  Your recommendations take the following structure:
  - **Recommendation Cluster:** A UI view that contains a group of
    recommendations from the same developer partner.

  - **Entity:** An object representing a single item in a cluster. This
    integration offers some entities that would be surfaced using the
    Recommendation Cluster:

    - **ArticleEntity**: ArticleEntity represents a recommendation for
      text-based content related to health \& fitness. It can be used for
      articles, blogposts, marketing content, news snippets, etc.

      ![](https://developer.android.com/static/images/guide/playcore/engage/article-entity-health-and-fitness.png) **Figure 1:** UI showing a single ArticleEntity within Recommendations cluster.
    - **PersonEntity**: PersonEntity represents a person. The
      recommendations could be to highlight a coach or any person related
      to health and fitness, etc.

      ![](https://developer.android.com/static/images/guide/playcore/engage/person-entity-health-and-fitness.png) **Figure 2:** UI showing a single PersonEntity within Recommendations cluster.
    - **EventEntity**: EventEntity represents an event happening in the
      future. Event start time is a critical piece of information that
      needs to be conveyed to the users This entity could be used for
      surfacing events like blood donation camp, training sessions, gym or
      yoga classes etc. related to health and fitness.

      ![](https://developer.android.com/static/images/guide/playcore/engage/event-entity-health-and-fitness.png) **Figure 3:** UI showing a single EventEntity within Recommendations cluster.
- The **Continuation** cluster shows content recently engaged by users from
  multiple developer partners in a single UI grouping. Each developer partner
  will be allowed to broadcast a maximum of 10 entities in the Continuation
  cluster.

  Your continuation content can take the following structure:
  - **ArticleEntity**: ArticleEntity represents a recommendation for
    text-based content that is related to health \& fitness. This entity can
    be used to represent unfinished news articles or other content that the
    user would like to continue consuming from where they left it. Ex: News
    snippet, blogpost snippet about health or fitness related topics.

    ![](https://developer.android.com/static/images/guide/playcore/engage/article-entity-continuation-health-and-fitness.png) **Figure 6.** UI showing a single ArticleEntity within a Continuation cluster.
  - **EventReservationEntity**: EventReservationEntity represents
    reservation for an event and helps users track upcoming or ongoing
    fitness and health events reservations. Ex: Training sessions

    ![](https://developer.android.com/static/images/guide/playcore/engage/event-reservation-entity-health-and-fitness.png) **Figure 8.** UI showing a single EventReservationEntity within a Continuation cluster.
- The **Featured** cluster showcases a selection of entities from multiple
  developer partners in one UI grouping. There will be a single Featured
  cluster, which is surfaced near the top of the UI with a priority placement
  above all Recommendation clusters. Each developer partner will be allowed to
  broadcast up to 10 entities in the Featured cluster.

  - **GenericFeaturedEntity**: GenericFeaturedEntity differs from
    Recommendation item in that Featured item should be used for a single
    top content from developers and should represent the single most
    important content that will be interesting and relevant to users.

    ![](https://developer.android.com/static/images/guide/playcore/engage/featured-item-health-and-fitness.png) **Figure 12:** UI showing a single hero GenericFeaturedEntity card within a Featured cluster

### Pre-work

Minimum API level: 19

Add the `com.google.android.engage:engage-core` library to your app:

    dependencies {
        // Make sure you also include that repository in your project's build.gradle file.
        implementation 'com.google.android.engage:engage-core:1.6.0'
    }

### Summary

The design is based on an implementation of a
[bound service](https://developer.android.com/guide/components/bound-services).

The data a client can publish is subject to the following limits for different
cluster types:

| Cluster type | Cluster limits | Minimum entity limits in a cluster | Maximum entity limits in a cluster |
|---|---|---|---|
| Recommendation Cluster(s) | At most 7 | At least 1 | At most 50 (`ArticleEntity`, `PersonEntity`, or `EventEntity`) |
| Continuation Cluster | At most 1 | At least 1 | At most 20 (`ArticleEntity`, or `EventReservationEntity`) |
| Featured Cluster | At most 1 | At least 1 | At most 20 (`GenericFeaturedEntity`) |

### Step 1: Provide entity data

The SDK has defined different entities to represent each item type. We support
the following entities for the Health \& Fitness category:

1. `GenericFeaturedEntity`
2. `ArticleEntity`
3. `PersonEntity`
4. `EventEntity`
5. `EventReservationEntity`

The charts below outline available attributes and requirements for each type.

#### `GenericFeaturedEntity`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | Deep Link to the entity in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Poster images | **Required** | We will show only 1 image when multiple images are provided. Recommended aspect ratio is 16:9 **Note:** If a badge is provided, please ensure safe space of 24 dps at both the top and bottom of the image | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Title | Optional | Title of the entity. | Free text **Recommended text size: 50 chars** |
| Description | Optional | A single paragraph of text to describe the entity. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size: 180 chars** |
| Subtitle list | Optional | Up to 3 subtitles, with each subtitle a single line of text. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size for each subtitle: max 50 chars** |
| Badges | Optional | Each badge is either free text (max 15 chars) or small image. Special UX treatment on top of image/video, for example as badge overlay on the image - "Live update" - Article read duration |   |
| Badge - Text | Optional | Title for the badge **Note:** Either text or image is required for the badge | Free text **Recommended text size: max 15 chars** |
| Badge - Image | Optional | Small image Special UX treatment, for example as badge overlay on the image/video thumbnail. **Note:** Either text or image is required for the badge | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Content Categories | Optional | Describe the category of the content in the entity. | List of Enums See the [Content Category section](https://developer.android.com/guide/playcore/engage/healthandfitness#content-category) for guidance. |

#### `ArticleEntity`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | Deep Link to the entity in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Title | **Required** | Title of the entity. | Free text **Recommended text size: Max 50 chars** |
| Poster images | Optional | We will show only 1 image when multiple images are provided. Recommended aspect ratio is 16:9 **Note:** Image is highly recommended. If a badge is provided, please ensure safe space of 24 dps at both the top and bottom of the image | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Source - Title | Optional | The name of the author, organization, or reporter | Free text **Recommended text size: Under 25 chars** |
| Source - Image | Optional | An image of the source like the author, the organization, reporter | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Description | Optional | A single paragraph of text to describe the entity. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size: 180 chars** |
| Subtitle list | Optional | Up to 3 subtitles, with each subtitle a single line of text. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size for each subtitle: max 50 chars** |
| Badges | Optional | Each badge is either free text (max 15 chars) or small image. Special UX treatment on top of image/video, for example as badge overlay on the image - "Live update" - Article read duration |   |
| Badge - Text | Optional | Title for the badge **Note:** Either text or image is required for the badge | Free text **Recommended text size: max 15 chars** |
| Badge - Image | Optional | Small image Special UX treatment, for example as badge overlay on the image/video thumbnail. **Note:** Either text or image is required for the badge | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Content Publish Time | Optional | This is the epoch timestamp in milliseconds on when the content was published / updated in the app. | Epoch timestamp in milliseconds |
| Last Engagement Time | Conditionally Required | The epoch timestamp in milliseconds when the user interacted with this entity last time. **Note:** This field is required if this entity is part of the continuation cluster. | Epoch timestamp in milliseconds |
| Progress Percentage | Conditionally Required | The percentage of the full content consumed by the user to date. **Note:** This field is required if this entity is part of the continuation cluster. | An int value between 0\~100 inclusive. |
| Content Categories | Optional | Describe the category of the content in the entity. | List of Enums See the [Content Category section](https://developer.android.com/guide/playcore/engage/healthandfitness#content-category) for guidance. |

#### `PersonEntity`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | Deep Link to the entity in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Profile - Name | **Required** | Profile name or id or handle, eg "John Doe", "@TeamPixel", etc. | String **Recommended text size: Max 50 chars** |
| Profile - Avatar | **Required** | Profile picture or avatar image of the user. **Note:**Must be Square 1:1 image. | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Profile - Additional Text | Optional | Free text like the profile handle. | Free text **Recommended text size: Max 15 chars** |
| Profile - Additional Image | Optional | Small image like a verified badge. | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Header image | Optional | We will show only 1 image when multiple images are provided. Recommended aspect ratio is 16:9 **Note:** Image is highly recommended. If a badge is provided, please ensure safe space of 24 dps at both the top and bottom of the image | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Popularity - Count | Optional | Indicate the number of followers or popularity value, for example - "3.7 M". **Note:** If both Count and Count Value are provided, Count will be used | String **Recommended text size: max 20 chars for count + label combined** |
| Popularity - Count Value | Optional | The number of followers or popularity value. **Note:** Provide Count Value if your app doesn't want to handle logic on how a large number should be optimized for different display sizes. If both Count and Count Value are provided, Count will be used. | Long |
| Popularity - Label | Optional | Indicate what the popularity label is. For example - "Likes". | String **Recommended text size: Max 20 chars for count + label combined** |
| Popularity - Visual | Optional | Indicate what the interaction is for. For example - Image showing Likes icon, Emojis. Can provide more than 1 image, though not all may not be shown on all form factors. **Note:** Must be Square 1:1 image | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Rating - Max value | Required | The maximum value of the rating scale. **Must be provided if current value of rating is also provided.** | Number \>= 0.0 |
| Rating - Current value | Required | The current value of the rating scale. **Must be provided if maximum value of rating is also provided.** | Number \>= 0.0 |
| Rating - Count | Optional | The count of the ratings for the entity. **Note:** Provide this field if your app controls how the count is displayed to the users. Use a concise string. For example, if the count is 1,000,000, consider using an abbreviation like 1M so that the count isn't truncated on smaller display sizes. | String |
| Rating - Count Value | Optional | The count of the ratings for the entity. **Note:** Provide this field if you don't handle the display abbreviation logic yourself. If both Count and Count Value are present, Count is displayed to users. | Long |
| Location - Country | Optional | The country where the person is located or serving. | Free text **Recommended text size: max \~20 chars** |
| Location - City | Optional | The city where the person is located or serving. | Free text **Recommended text size: max \~20 chars** |
| Location - Display Address | Optional | The address where the person is located or serving will be displayed to the user. | Free text **Recommended text size: max \~20 chars** |
| Location - Street Address | Optional | The street address (if applicable) where the person is located or serving. | Free text **Recommended text size: max \~20 chars** |
| Location - State | Optional | The state (if applicable) where the person is located or serving. | Free text **Recommended text size: max \~20 chars** |
| Location - Zip code | Optional | The zip code (if applicable) where the person is located or serving. | Free text **Recommended text size: max \~20 chars** |
| Location - Neighborhood | Optional | The neighborhood (if applicable) where the person is located or serving. | Free text **Recommended text size: max \~20 chars** |
| Badges | Optional | Each badge is either free text (max 15 chars) or small image. |   |
| Badge - Text | Optional | Title for the badge **Note:** Either text or image is required for the badge | Free text **Recommended text size: max 15 chars** |
| Badge - Image | Optional | Small image Special UX treatment, for example as badge overlay on the image/video thumbnail. **Note:** Either text or image is required for the badge | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Description | Optional | A single paragraph of text to describe the entity. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size: 180 chars** |
| Subtitle list | Optional | Up to 3 subtitles, with each subtitle a single line of text. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size for each subtitle: max 50 chars** |
| Content Categories | Optional | Describe the category of the content in the entity. | List of Eligible Enums - TYPE_HEALTH_AND_FITENESS (Example - Yoga/fitness trainer) - TYPE_HOME_AND_AUTO (Example - Plumber) - TYPE_SPORTS (Example - Player) - TYPE_DATING See the [Content Category section](https://developer.android.com/guide/playcore/engage/healthandfitness#content-category) for guidance. |

#### `EventEntity`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | Deep Link to the entity in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Title | **Required** | Title of the entity. | String **Recommended text size: Max 50 chars** |
| Start time | **Required** | The epoch timestamp when the event is expected to start. **Note:**This will be represented in milliseconds. | Epoch timestamp in milliseconds |
| Event mode | **Required** | A field to indicate whether the event will be virtual, in-person or both. | Enum: VIRTUAL, IN_PERSON, or HYBRID |
| Poster images | **Required** | We will show only 1 image when multiple images are provided. Recommended aspect ratio is 16:9 **Note:** Image is highly recommended. If a badge is provided, please ensure safe space of 24 dps at both the top and bottom of the image | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Location - Country | Conditionally Required | The country in which the event is happening. **Note:** This is required for events which are IN_PERSON or HYBRID | Free text **Recommended text size: max \~20 chars** |
| Location - City | Conditionally Required | The city in which the event is happening. **Note:** This is required for events which are IN_PERSON or HYBRID | Free text **Recommended text size: max \~20 chars** |
| Location - Display Address | Conditionally Required | The address or venue name where the event will take place that should be displayed to the user. **Note:** This is required for events which are IN_PERSON or HYBRID | Free text **Recommended text size: max \~20 chars** |
| Location - Street Address | Optional | The street address (if applicable) of the location at which event is being hosted. | Free text **Recommended text size: max \~20 chars** |
| Location - State | Optional | The state or province (if applicable) in which the event is being hosted. | Free text **Recommended text size: max \~20 chars** |
| Location - Zip code | Optional | The zip code (if applicable) of the location in which the event is being hosted. | Free text **Recommended text size: max \~20 chars** |
| Location - Neighborhood | Optional | The neighborhood (if applicable) in which the event is being hosted. | Free text **Recommended text size: max \~20 chars** |
| End time | Optional | The epoch timestamp when the event is expected to end. **Note:**This will be represented in milliseconds. | Epoch timestamp in milliseconds |
| Description | Optional | A single paragraph of text to describe the entity. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size: 180 chars** |
| Subtitle list | Optional | Up to 3 subtitles, with each subtitle a single line of text. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size for each subtitle: max 50 chars** |
| Badges | Optional | Each badge is either free text (max 15 chars) or small image. |   |
| Badge - Text | Optional | Title for the badge **Note:** Either text or image is required for the badge | Free text **Recommended text size: max 15 chars** |
| Badge - Image | Optional | Small image Special UX treatment, for example as badge overlay on the image/video thumbnail. **Note:** Either text or image is required for the badge | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Price - CurrentPrice | Conditionally required | The current price of the ticket/pass for the event. **Must be provided if strikethrough price is provided.** | Free text |
| Price - StrikethroughPrice | Optional | The original price of the ticket/pass for the event. | Free text |
| Price Callout | Optional | Price callout to feature a promo, event, member discount, if available. | Free text **Recommended text size: under 45 chars (Text that is too long may show ellipses)** |
| Content Categories | Optional | Describe the category of the content in the entity. | List of Eligible Enums - TYPE_MOVIES_AND_TV_SHOWS (Example - Cinema) - TYPE_DIGITAL_GAMES (Example - eSports) - TYPE_MUSIC (Example - Concert) - TYPE_TRAVEL_AND_LOCAL (Example - Tour, festival) - TYPE_HEALTH_AND_FITENESS (Example - Yoga class) - TYPE_EDUCATION (Example - Class) - TYPE_SPORTS (Example - Football game) - TYPE_DATING (Example - meetup) See the [Content Category section](https://developer.android.com/guide/playcore/engage/healthandfitness#content-category) for guidance. |

#### `EventReservationEntity`

| Attribute | Requirement | Description | Format |
|---|---|---|---|
| Action Uri | **Required** | Deep Link to the entity in the provider app. Note: You can use deep links for attribution. [Refer to this FAQ](https://developer.android.com/guide/playcore/engage/faq#deeplinks-attribution) | Uri |
| Title | **Required** | Title of the entity. | String **Recommended text size: Max 50 chars** |
| Start time | **Required** | The epoch timestamp when the event is expected to start. **Note:**This will be represented in milliseconds. | Epoch timestamp in milliseconds |
| Event mode | **Required** | A field to indicate whether the event will be virtual, in-person or both. | Enum: VIRTUAL, IN_PERSON, or HYBRID |
| Location - Country | Conditionally Required | The country in which the event is happening. **Note:** This is required for events which are IN_PERSON or HYBRID | Free text **Recommended text size: max \~20 chars** |
| Location - City | Conditionally Required | The city in which the event is happening. **Note:** This is required for events which are IN_PERSON or HYBRID | Free text **Recommended text size: max \~20 chars** |
| Location - Display Address | Conditionally Required | The address or venue name where the event will take place that should be displayed to the user. **Note:** This is required for events which are IN_PERSON or HYBRID | Free text **Recommended text size: max \~20 chars** |
| Location - Street Address | Optional | The street address (if applicable) of the location at which event is being hosted. | Free text **Recommended text size: max \~20 chars** |
| Location - State | Optional | The state or province (if applicable) in which the event is being hosted. | Free text **Recommended text size: max \~20 chars** |
| Location - Zip code | Optional | The zip code (if applicable) of the location in which the event is being hosted. | Free text **Recommended text size: max \~20 chars** |
| Location - Neighborhood | Optional | The neighborhood (if applicable) in which the event is being hosted. | Free text **Recommended text size: max \~20 chars** |
| Poster images | Optional | We will show only 1 image when multiple images are provided. Recommended aspect ratio is 16:9 **Note:** Image is highly recommended. If a badge is provided, please ensure safe space of 24 dps at both the top and bottom of the image | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| End time | Optional | The epoch timestamp when the event is expected to end. **Note:**This will be represented in milliseconds. | Epoch timestamp in milliseconds |
| Service Provider - Name | Optional | The name of the service provider. **Note:**Either text or image is required for the service provider. | Free text. For example, name of the event organizer/tour |
| Service Provider - Image | Optional | The logo/image of the service provider. **Note:**Either text or image is required for the service provider. | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Description | Optional | A single paragraph of text to describe the entity. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size: 180 chars** |
| Subtitle list | Optional | Up to 3 subtitles, with each subtitle a single line of text. **Note:** Either description or subtitle list will be displayed to the user, not both. | Free text **Recommended text size for each subtitle: max 50 chars** |
| Badges | Optional | Each badge is either free text (max 15 chars) or small image. |   |
| Badge - Text | Optional | Title for the badge **Note:** Either text or image is required for the badge | Free text **Recommended text size: max 15 chars** |
| Badge - Image | Optional | Small image Special UX treatment, for example as badge overlay on the image/video thumbnail. **Note:** Either text or image is required for the badge | See [Image Specifications](https://developer.android.com/guide/playcore/engage/healthandfitness#image-specs) for guidance. |
| Reservation ID | Optional | The reservation ID for the event reservation. | Free text |
| Price - CurrentPrice | Conditionally required | The current price of the ticket/pass for the event. **Must be provided if strikethrough price is provided.** | Free text |
| Price - StrikethroughPrice | Optional | The original price of the ticket/pass for the event. | Free text |
| Price Callout | Optional | Price callout to feature a promo, event, member discount, if available. | Free text **Recommended text size: under 45 chars (Text that is too long may show ellipses)** |
| Rating - Max value | Optional | The maximum value of the rating scale. **Must be provided if current value of rating is also provided.** | Number \>= 0.0 |
| Rating - Current value | Optional | The current value of the rating scale. **Must be provided if maximum value of rating is also provided.** | Number \>= 0.0 |
| Rating - Count | Optional | The count of the ratings for the event. **Note:** Provide this field if your app wants to control how this is displayed to the users. Please provide the concise string that can be displayed to the user. For example, if the count is 1,000,000, consider using abbreviations like 1M, so that it won't be truncated on smaller display sizes. | String |
| Rating - Count Value | Optional | The count of the ratings for the event. **Note:** Provide this field if you don't want to handle the display abbreviation logic yourself. If both Count and Count Value are present, we will use the Count to display to users | Long |
| Content Categories | Optional | Describe the category of the content in the entity. | List of Eligible Enums - TYPE_MOVIES_AND_TV_SHOWS (Example - Cinema) - TYPE_DIGITAL_GAMES (Example - eSports) - TYPE_MUSIC (Example - Concert) - TYPE_TRAVEL_AND_LOCAL (Example - Tour, festival) - TYPE_HEALTH_AND_FITENESS (Example - Yoga class) - TYPE_EDUCATION (Example - Class) - TYPE_SPORTS (Example - Football game) - TYPE_DATING (Example - meetup) See the [Content Category section](https://developer.android.com/guide/playcore/engage/healthandfitness#content-category) for guidance. |

#### Image specifications

Required specifications for image assets are listed in this table:

| Aspect ratio | Minimum pixels | Recommended pixels |
|---|---|---|
| Square (1x1) **Preferred** | 300x300 | 1200x1200 |
| Landscape (1.91x1) | 600x314 | 1200x628 |
| Portrait (4x5) | 480x600 | 960x1200 |

The images are required to be hosted on public CDNs so that Google can access
them.

*File formats*

PNG, JPG, static GIF, WebP

*Maximum file size*

5120 KB

*Additional recommendations*

- **Image safe area:** Put your important content in the center 80% of the image.
- Use a transparent background so that the image can be properly displayed in Dark and Light theme settings.

#### Content Category

The content category allows apps to publish content belonging to multiple
categories. This maps the content with some of the predefined categories namely:

- `TYPE_EDUCATION`
- `TYPE_SPORTS`
- `TYPE_MOVIES_AND_TV_SHOWS`
- `TYPE_BOOKS`
- `TYPE_AUDIOBOOKS`
- `TYPE_MUSIC`
- `TYPE_DIGITAL_GAMES`
- `TYPE_TRAVEL_AND_LOCAL`
- `TYPE_HOME_AND_AUTO`
- `TYPE_BUSINESS`
- `TYPE_NEWS`
- `TYPE_FOOD_AND_DRINK`
- `TYPE_SHOPPING`
- `TYPE_HEALTH_AND_FITENESS`
- `TYPE_MEDICAL`
- `TYPE_PARENTING`
- `TYPE_DATING`

The images are required to be hosted on public CDNs so that Google can access
them.

*Guidelines to use the content categories*

1. Some entities like **ArticleEntity** and **GenericFeaturedEntity** are eligible to use any of the content categories. For other entities like **EventEntity** , **EventReservationEntity** , **PersonEntity**, only a subset of these categories are eligible. Check the list of categories eligible for an entity type before populating the list.
2. Use the specific entity type for some content categories over a combination
   of the Generic entities and the ContentCategory:

   - TYPE_MOVIES_AND_TV_SHOWS - Check out the entities from [Watch integration guide](https://developer.android.com/guide/playcore/engage/watch) before using the generic entities.
   - TYPE_BOOKS - Check out the [EbookEntity](https://developer.android.com/guide/playcore/engage/read#ebookentity) before using the generic entities.
   - TYPE_AUDIOBOOKS - Check out [AudiobookEntity](https://developer.android.com/guide/playcore/engage/read#audiobookentity) before using the generic entities.
   - TYPE_SHOPPING - Check out [ShoppingEntity](https://developer.android.com/guide/playcore/engage/shopping#shoppingEntity) before using the generic entities.
   - TYPE_FOOD_AND_DRINK - Check out entities from [Food Integration guide](https://developer.android.com/guide/playcore/engage/food) before using the generic entities.
3. The ContentCategory field is optional and should be left blank if the
   content doesn't belong to any of the categories mentioned earlier.

4. In case multiple content categories are provided, provide them in the order
   of relevance to the content with the most relevant content category placed
   first in the list.

### Step 2: Provide Cluster data

It is recommended to have the content publish job executed in the background
(for example, using [WorkManager](https://developer.android.com/topic/libraries/architecture/workmanager))
and scheduled on a regular basis or on an event basis (for example, every time
the user opens the app or when the user just added something to their cart).

`AppEngagePublishClient` is responsible for publishing clusters.

There are following APIs to publish clusters in the client:

- `isServiceAvailable`
- `publishRecommendationClusters`
- `publishFeaturedCluster`
- `publishContinuationCluster`
- `publishUserAccountManagementRequest`
- `updatePublishStatus`
- `deleteRecommendationsClusters`
- `deleteFeaturedCluster`
- `deleteContinuationCluster`
- `deleteUserManagementCluster`
- `deleteClusters`

#### `isServiceAvailable`

This API is used to check if the service is available for integration and
whether the content can be presented on the device.

##### For Engage SDK v1.6.0 and higher (Recommended)

You can check the service availability for every cluster type that you intend to
publish. The `isServiceAvailable` API accepts a request object,
`ServiceAvailabilityRequest`, which contains the cluster types for which service
availability needs to be checked. You can find the `ClusterType` enum values
required for `ServiceAvailabilityRequest` from the following table.

| Cluster Type | Cluster Type Constant | Integer Value |
|---|---|---|
| Unknown | `TYPE_UNKNOWN` | 0 |
| Recommendation Cluster | `TYPE_RECOMMENDATION` | 1 |
| Featured Cluster | `TYPE_FEATURED` | 2 |
| Continuation Cluster | `TYPE_CONTINUATION` | 3 |
| User Management Cluster | `TYPE_ENGAGEMENT` | 8 |
| Subscription Cluster | `TYPE_SUBSCRIPTION` | 12 |

### Kotlin

    val request = ServiceAvailabilityRequest.Builder()
        .addIntendedClusterType(ClusterType.TYPE_CONTINUATION)
        .addIntendedClusterType(ClusterType.TYPE_RECOMMENDATION)
        .build()

    client.isServiceAvailable(request).addOnCompleteListener { task ->
        if (task.isSuccessful) {
            val availabilityMap = task.result
            if (availabilityMap[ClusterType.TYPE_CONTINUATION] == true) {
                // Proceed with publishing continuation content
            }
            if (availabilityMap[ClusterType.TYPE_RECOMMENDATION] == true) {
                // Proceed with publishing recommendation content
            }
        } else {
            // The IPC call itself fails, proceed with error handling logic here,
            // such as retry.
        }
    }

### Java

    ServiceAvailabilityRequest request =
        new ServiceAvailabilityRequest.Builder()
            .addIntendedClusterType(ClusterType.TYPE_CONTINUATION)
            .addIntendedClusterType(ClusterType.TYPE_RECOMMENDATION)
            .build();

    client.isServiceAvailable(request).addOnCompleteListener(task -> {
        if (task.isSuccessful()) {
            Map<Integer, Boolean> availabilityMap = task.getResult();
            if (Boolean.TRUE.equals(availabilityMap.get(ClusterType.TYPE_CONTINUATION))) {
                // Proceed with publishing continuation content
            }
            if (Boolean.TRUE.equals(availabilityMap.get(ClusterType.TYPE_RECOMMENDATION))) {
                // Proceed with publishing recommendation content
            }
        } else {
            // The IPC call itself fails, proceed with error handling logic here,
            // such as retry.
        }
    });

###### Conditional Service Availability Feature

Some integrated apps request a special configuration that enables and disables
the Engage service intermittently in order to reduce their serving cost. This
intermittent content ingestion strategy, although possible, negatively affects
the user and the product -- stale content will not be presented and some surfaces
will not be served at all.

Starting with v1.6.0, the Engage SDK allows checking availability for specific
cluster types. This provides more flexibility so that if the intermittent
content strategy was adopted by a given application, some cluster types can
follow that intermittent strategy while other cluster types are always enabled
(i.e. continuation clusters).

If the Engage service should not be 'continuously' enabled on all supported
devices for whatever reason, and is configured for intermittent ingestion for
any set of devices, all continuation cluster publications (e.g. Continue
Reading and Event Reservations) will be still enabled by default
configuration, and the rest of the cluster types will be enabled and disabled
intermittently. If intermittent ingestion applies to you but this default
configuration is not suitable for your needs, please contact
engage-developers@google.com.

##### For SDK versions prior to v1.6.0 (Deprecated)

### Kotlin

    client.isServiceAvailable.addOnCompleteListener { task ->
        if (task.isSuccessful) {
            // Handle IPC call success
            if(task.result) {
              // Service is available on the device, proceed with content publish
              // calls.
            } else {
              // Service is not available, no further action is needed.
            }
        } else {
          // The IPC call itself fails, proceed with error handling logic here,
          // such as retry.
        }
    }

### Java

    client.isServiceAvailable().addOnCompleteListener(task - > {
        if (task.isSuccessful()) {
            // Handle success
            if(task.getResult()) {
              // Service is available on the device, proceed with content publish
              // calls.
            } else {
              // Service is not available, no further action is needed.
            }
        } else {
          // The IPC call itself fails, proceed with error handling logic here,
          // such as retry.
        }
    });

> [!NOTE]
> **Note:** We highly recommend keeping a periodic job running to check if the service becomes available at a later point in time. The availability of the service may change with Android version upgrades, app upgrades, installs, and uninstalls. By ensuring periodic job checks at a certain time interval, data can be published once the service becomes available.

#### `publishRecommendationClusters`

This API is used to publish a list of `RecommendationCluster` objects.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishRecommendationClusters(
          PublishRecommendationClustersRequest.Builder()
            .addRecommendationCluster(
              RecommendationCluster.Builder()
                .addEntity(entity1)
                .addEntity(entity2)
                .setTitle("Top Picks For You")
                .build()
            )
            .build()
        )

### Java

    client.publishRecommendationClusters(
                new PublishRecommendationClustersRequest.Builder()
                    .addRecommendationCluster(
                        new RecommendationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .setTitle("Top Picks For You")
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `RecommendationCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Recommendation Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishFeaturedCluster`

This API is used to publish a list of `FeaturedCluster` objects.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishFeaturedCluster(
        PublishFeaturedClusterRequest.Builder()
          .setFeaturedCluster(
            FeaturedCluster.Builder()
              .addEntity(entity1)
              .addEntity(entity2)
              .build())
          .build())

### Java

    client.publishFeaturedCluster(
                new PublishFeaturedClustersRequest.Builder()
                    .addFeaturedCluster(
                        new FeaturedCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `FeaturedCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Featured Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishContinuationCluster`

This API is used to publish a `ContinuationCluster` object.

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    client.publishContinuationCluster(
        PublishContinuationClusterRequest.Builder()
          .setContinuationCluster(
            ContinuationCluster.Builder()
              .addEntity(entity1)
              .addEntity(entity2)
              .build())
          .build())

### Java

    client.publishContinuationCluster(
                new PublishContinuationClusterRequest.Builder()
                    .setContinuationCluster(
                        new ContinuationCluster.Builder()
                            .addEntity(entity1)
                            .addEntity(entity2)
                            .build())
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `ContinuationCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated Continuation Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `publishUserAccountManagementRequest`

This API is used to publish a Sign In card . The signin action directs users to
the app's sign in page so that the app can publish content (or provide more
personalized content)

The following metadata is part of the Sign In Card -

| Attribute | Requirement | Description |
|---|---|---|
| Action Uri | Required | Deeplink to Action (i.e. navigates to app sign in page) |
| Image | Optional - If not provided, Title must be provided | Image Shown on the Card 16x9 aspect ratio images with a resolution of 1264x712 |
| Title | Optional - If not provided, Image must be provided | Title on the Card |
| Action Text | Optional | Text Shown on the CTA (i.e. Sign in) |
| Subtitle | Optional | Optional Subtitle on the Card |

> [!IMPORTANT]
> **Important:** The publish APIs are upsert APIs; it replaces the existing content. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently.

### Kotlin

    var SIGN_IN_CARD_ENTITY =
          SignInCardEntity.Builder()
              .addPosterImage(
                  Image.Builder()
                      .setImageUri(Uri.parse("http://www.x.com/image.png"))
                      .setImageHeightInPixel(500)
                      .setImageWidthInPixel(500)
                      .build())
              .setActionText("Sign In")
              .setActionUri(Uri.parse("http://xx.com/signin"))
              .build()

    client.publishUserAccountManagementRequest(
                PublishUserAccountManagementRequest.Builder()
                    .setSignInCardEntity(SIGN_IN_CARD_ENTITY)
                    .build());

### Java

    SignInCardEntity SIGN_IN_CARD_ENTITY =
          new SignInCardEntity.Builder()
              .addPosterImage(
                  new Image.Builder()
                      .setImageUri(Uri.parse("http://www.x.com/image.png"))
                      .setImageHeightInPixel(500)
                      .setImageWidthInPixel(500)
                      .build())
              .setActionText("Sign In")
              .setActionUri(Uri.parse("http://xx.com/signin"))
              .build();

    client.publishUserAccountManagementRequest(
                new PublishUserAccountManagementRequest.Builder()
                    .setSignInCardEntity(SIGN_IN_CARD_ENTITY)
                    .build());

When the service receives the request, the following actions take place within
one transaction:

- Existing `UserAccountManagementCluster` data from the developer partner is removed.
- Data from the request is parsed and stored in the updated UserAccountManagementCluster Cluster.

In case of an error, the entire request is rejected and the existing state is
maintained.

#### `updatePublishStatus`

If for any internal business reason, none of the clusters is published, we
**strongly recommend** updating the publish status using the
**updatePublishStatus** API. This is important because :

- Providing the status in all scenarios, even when the content is published (STATUS == PUBLISHED), is critical to populate dashboards that use this explicit status to convey the health and other metrics of your integration.
- If no content is published but the integration status isn't broken (STATUS == NOT_PUBLISHED), Google can avoid triggering alerts in the app health dashboards. It confirms that content is not published due to an **expected** situation from the provider's standpoint.
- It helps developers provide insights into when the data is published versus not.
- Google may use the status codes to nudge the user to do certain actions in the app so they can see the app content or overcome it.

The list of eligible publish status codes are :

    // Content is published
    AppEngagePublishStatusCode.PUBLISHED,

    // Content is not published as user is not signed in
    AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SIGN_IN,

    // Content is not published as user is not subscribed
    AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SUBSCRIPTION,

    // Content is not published as user location is ineligible
    AppEngagePublishStatusCode.NOT_PUBLISHED_INELIGIBLE_LOCATION,

    // Content is not published as there is no eligible content
    AppEngagePublishStatusCode.NOT_PUBLISHED_NO_ELIGIBLE_CONTENT,

    // Content is not published as the feature is disabled by the client
    // Available in v1.3.1
    AppEngagePublishStatusCode.NOT_PUBLISHED_FEATURE_DISABLED_BY_CLIENT,

    // Content is not published as the feature due to a client error
    // Available in v1.3.1
    AppEngagePublishStatusCode.NOT_PUBLISHED_CLIENT_ERROR,

    // Content is not published as the feature due to a service error
    // Available in v1.3.1
    AppEngagePublishStatusCode.NOT_PUBLISHED_SERVICE_ERROR,

    // Content is not published due to some other reason
    // Reach out to engage-developers@ before using this enum.
    AppEngagePublishStatusCode.NOT_PUBLISHED_OTHER

If the content is not published due to a user not logged in, Google would
recommend publishing the Sign In Card. If for any reason providers are not able
to publish the Sign In Card then we recommend calling the
**updatePublishStatus** API with the status code
**NOT_PUBLISHED_REQUIRES_SIGN_IN**

### Kotlin

    client.updatePublishStatus(
       PublishStatusRequest.Builder()
         .setStatusCode(AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SIGN_IN)
         .build())

### Java

    client.updatePublishStatus(
        new PublishStatusRequest.Builder()
            .setStatusCode(AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SIGN_IN)
            .build());

#### `deleteRecommendationClusters`

This API is used to delete the content of Recommendation Clusters.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteRecommendationClusters()

### Java

    client.deleteRecommendationClusters();

When the service receives the request, it removes the existing data from the
Recommendation Clusters. In case of an error, the entire request is rejected and
the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteFeaturedCluster`

This API is used to delete the content of Featured Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteFeaturedCluster()

### Java

    client.deleteFeaturedCluster();

When the service receives the request, it removes the existing data from the
Featured Cluster. In case of an error, the entire request is rejected and the
existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteContinuationCluster`

This API is used to delete the content of Continuation Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteContinuationCluster()

### Java

    client.deleteContinuationCluster();

When the service receives the request, it removes the existing data from the
Continuation Cluster. In case of an error, the entire request is rejected and
the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteUserManagementCluster`

This API is used to delete the content of UserAccountManagement Cluster.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteUserManagementCluster()

### Java

    client.deleteUserManagementCluster();

When the service receives the request, it removes the existing data from the
UserAccountManagement Cluster. In case of an error, the entire request is
rejected and the existing state is maintained.

> [!NOTE]
> **Note:** This api is available from version 1.1.0 onwards.

#### `deleteClusters`

This API is used to delete the content of a given cluster type.

> [!IMPORTANT]
> **Important:** Delete APIs should only be called when there is no content to publish. **Don't** call delete and publish APIs subsequently to replace the content as the publish APIs do that inherently. Reach out to [`engage-developers@google.com`](mailto:engage-developers@google.com) before using delete APIs.

### Kotlin

    client.deleteClusters(
        DeleteClustersRequest.Builder()
          .addClusterType(ClusterType.TYPE_CONTINUATION)
          .addClusterType(ClusterType.TYPE_FEATURED)
          .addClusterType(ClusterType.TYPE_RECOMMENDATION)
          .build())

### Java

    client.deleteClusters(
                new DeleteClustersRequest.Builder()
                    .addClusterType(ClusterType.TYPE_CONTINUATION)
                    .addClusterType(ClusterType.TYPE_FEATURED)
                    .addClusterType(ClusterType.TYPE_RECOMMENDATION)
                    .build());

When the service receives the request, it removes the existing data from all
clusters matching the specified cluster types. Clients can choose to pass one or
many cluster types. In case of an error, the entire request is rejected and the
existing state is maintained.

#### Error handling

It is highly recommended to listen to the task result from the publish APIs such
that a follow-up action can be taken to recover and resubmit an successful task.

### Kotlin

    client.publishRecommendationClusters(
            PublishRecommendationClustersRequest.Builder()
              .addRecommendationCluster(..)
              .build())
          .addOnCompleteListener { task ->
            if (task.isSuccessful) {
              // do something
            } else {
              val exception = task.exception
              if (exception is AppEngageException) {
                @AppEngageErrorCode val errorCode = exception.errorCode
                if (errorCode == AppEngageErrorCode.SERVICE_NOT_FOUND) {
                  // do something
                }
              }
            }
          }

### Java

    client.publishRecommendationClusters(
                  new PublishRecommendationClustersRequest.Builder()
                      .addRecommendationCluster(...)
                      .build())
              .addOnCompleteListener(
                  task -> {
                    if (task.isSuccessful()) {
                      // do something
                    } else {
                      Exception exception = task.getException();
                      if (exception instanceof AppEngageException) {
                        @AppEngageErrorCode
                        int errorCode = ((AppEngageException) exception).getErrorCode();
                        if (errorCode == AppEngageErrorCode.SERVICE_NOT_FOUND) {
                          // do something
                        }
                      }
                    }
                  });

The error is returned as an `AppEngageException` with the cause included as an
error code.

| Error code | Error name | Note |
|---|---|---|
| `1` | `SERVICE_NOT_FOUND` | The service is not available on the given device. |
| `2` | `SERVICE_NOT_AVAILABLE` | The service is available on the given device, but it is not available at the time of the call (for example, it is explicitly disabled). |
| `3` | `SERVICE_CALL_EXECUTION_FAILURE` | The task execution failed due to threading issues. In this case, it can be retried. |
| `4` | `SERVICE_CALL_PERMISSION_DENIED` | The caller is not allowed to make the service call. |
| `5` | `SERVICE_CALL_INVALID_ARGUMENT` | The request contains invalid data (for example, more than the allowed number of clusters). |
| `6` | `SERVICE_CALL_INTERNAL` | There is an error on the service side. |
| `7` | `SERVICE_CALL_RESOURCE_EXHAUSTED` | The service call is made too frequently. |

### Step 3: Handle broadcast intents

In addition to making publish content API calls through a job, it is also
required to set up a
[`BroadcastReceiver`](https://developer.android.com/reference/android/content/BroadcastReceiver) to receive
the request for a content publish.

The goal of broadcast intents is mainly for app reactivation and forcing data
sync. Broadcast intents are not designed to be sent very frequently. It is only
triggered when the Engage Service determines the content might be stale (for
example, a week old). That way, there is more confidence that the user can have
a fresh content experience, even if the application has not been executed for a
long period of time.

The `BroadcastReceiver` must be set up in the following two ways:

- Dynamically register an instance of the `BroadcastReceiver` class using
  `Context.registerReceiver()`. This enables communication from applications
  that are still live in memory.

### Kotlin

    class AppEngageBroadcastReceiver : BroadcastReceiver(){
      // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION broadcast
      // is received
      // Trigger featured cluster publish when PUBLISH_FEATURED broadcast is received
      // Trigger continuation cluster publish when PUBLISH_CONTINUATION broadcast is
      // received
    }

    fun registerBroadcastReceivers(context: Context){
      var  context = context
      context = context.applicationContext

    // Register Recommendation Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_RECOMMENDATION),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register Featured Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_FEATURED),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)

    // Register Continuation Cluster Publish Intent
      context.registerReceiver(AppEngageBroadcastReceiver(),
                               IntentFilter(Intents.ACTION_PUBLISH_CONTINUATION),
                               com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                               /*scheduler=*/null)
    }

### Java

    class AppEngageBroadcastReceiver extends BroadcastReceiver {
    // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION broadcast
    // is received

    // Trigger featured cluster publish when PUBLISH_FEATURED broadcast is received

    // Trigger continuation cluster publish when PUBLISH_CONTINUATION broadcast is
    // received
    }

    public static void registerBroadcastReceivers(Context context) {

    context = context.getApplicationContext();

    // Register Recommendation Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.service.Intents.ACTION_PUBLISH_RECOMMENDATION),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register Featured Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.service.Intents.ACTION_PUBLISH_FEATURED),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    // Register Continuation Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.service.Intents.ACTION_PUBLISH_CONTINUATION),
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null);

    }

- Statically declare an implementation with the `<receiver>` tag in your
  `AndroidManifest.xml` file. This allows the application to receive broadcast
  intents when it is not running, and also allows the application to publish
  the content.

    <application>
       <receiver
          android:name=".AppEngageBroadcastReceiver"
          android:permission="com.google.android.engage.REQUEST_ENGAGE_DATA"
          android:exported="true"
          android:enabled="true">
          <intent-filter>
             <action android:name="com.google.android.engage.action.PUBLISH_RECOMMENDATION" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.PUBLISH_FEATURED" />
          </intent-filter>
          <intent-filter>
             <action android:name="com.google.android.engage.action.PUBLISH_CONTINUATION" />
          </intent-filter>
       </receiver>
    </application>

The following [intents](https://developer.android.com/reference/android/content/Intent) is sent by the
service:

- `com.google.android.engage.action.PUBLISH_RECOMMENDATION` It is recommended to start a `publishRecommendationClusters` call when receiving this intent.
- `com.google.android.engage.action.PUBLISH_FEATURED` It is recommended to start a `publishFeaturedCluster` call when receiving this intent.
- `com.google.android.engage.action.PUBLISH_CONTINUATION` It is recommended to start a `publishContinuationCluster` call when receiving this intent.

## Integration workflow

For a step-by-step guide on verifying your integration after it is complete, see
[Engage developer integration workflow](https://developer.android.com/guide/playcore/engage/workflow).

## FAQs

See [Engage SDK Frequently Asked Questions](https://developer.android.com/guide/playcore/engage/faq) for
FAQs.

## Contact

Contact
[`engage-developers@google.com`](mailto:engage-developers@google.com) if there are
any questions during the integration process.

## Next steps

After completing this integration, your next steps are as follows:

- Send an email to [`engage-developers@google.com`](mailto:engage-developers@google.com) and attach your integrated APK that is ready for testing by Google.
- Google performs a verification and reviews internally to make sure the integration works as expected. If changes are needed, Google contacts you with any necessary details.
- When testing is complete and no changes are needed, Google contacts you to notify you that you can start publishing the updated and integrated APK to the Play Store.
- After Google has confirmed that your updated APK has been published to the Play Store, your **Recommendation** , **Featured** , and **Continuation** clusters may be published and visible to users.