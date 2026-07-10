## Publish FAQs

#### Who manages the content publishing job?

The app developer manages the content publishing job and sends requests to the
Engage Service. In this way, developer partners have more control over when and
how to publish content to the users. This avoids waking up the partner app too
frequently to publish content.

#### Does a developer need to publish all cluster types?

While technically developers are free to publish just one cluster, we **strongly
advise** including more. Otherwise, developers miss the opportunity to drive
better engagement with their content. We **highly recommend** publishing all
cluster types for each vertical.

#### How often should the developer partner be publishing data using the work manager while the app is running?

This is to be decided by the developer partner. Google recommends publishing
once or twice per day for general recommendation content, and to use an
event-driven methodology for shopping cart, reorder, and other continuation
content (for example, start the worker as a callback of the user adding items
to the cart or the user stopping a movie halfway).
For **social** apps, it's critical to publish updated recommendation clusters
**after each app usage**. Social app users are more interested in the most
recent recommendations and ideally would like to see a post at most once.

#### When should the developer call delete APIs?

Delete APIs should only be called when there is no content to publish. **Don't**
call delete and publish APIs subsequently to replace content; the publish
APIs remove the earlier content automatically.

## Broadcast Intent FAQs

#### Why do Android app developers need to register for broadcast intents?

In order to serve fresh content to the user, you should use broadcast intents to
trigger a data sync in cases where users might not use the app frequently.

#### Unable to test broadcast intent

The verification app doesn't support testing broadcast intent with
permission. You have to remove permissions while testing and
add them back before switching the SDK to prod version in [Step 6](https://developer.android.com/guide/playcore/engage/workflow#switch-to-prod).

#### Background execution not allowed

While registering the broadcast intent, you may come across the following error:

    Background execution not allowed: receiving Intent
    { act=com.google.android.engage.action.PUBLISH_RECOMMENDATION .. }

You need to register the broadcast receivers dynamically.

    class AppEngageBroadcastReceiver extends BroadcastReceiver {
    // Trigger recommendation cluster publish when PUBLISH_RECOMMENDATION broadcast
    // is received
    }

    public static void registerBroadcastReceivers(Context context) {

    context = context.getApplicationContext();

    // Register Recommendation Cluster Publish Intent
    context.registerReceiver(new AppEngageBroadcastReceiver(),
                             new IntentFilter(com.google.android.engage.service.Intents.ACTION_PUBLISH_RECOMMENDATION,
                             com.google.android.engage.service.BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                             /*scheduler=*/null));
    ...

    }

## Workflow FAQs

While integrating with the SDK, you may come across the following errors:

#### Validation errors at the app, cluster, entity level

Summaries at the app, cluster, and entity levels display a count of
validation errors. These errors correspond to missing required fields or
invalid values provided. Error messages show up in red beneath each relevant
field. Fix all validation errors and check for correctness before sharing
the APK.

#### Testing Deep links

The deep links are associated with the package name. A good way to test
deep links is using the adb tool.

    adb shell am start -W -a android.intent.action.VIEW -d <DEEPLINK URI> <PACKAGE NAME>

#### How can I calculate the impact of the integration?

The deep links are a great way to track the attribution. The deep link URLs
that take users to your app can be included with additional tracking params.
For example - "http://xx/deeplink?source_tag=engage".

Developers can add their own tracking params and provide attribution to
calculate impact.

## Engage for TV 2.0 FAQs

### General Questions

#### What is Engage?

Engage takes the "pick up where you left off" experience to the next level! It's
a significant upgrade that allows viewers to seamlessly resume their content
across a wider range of devices. Imagine starting a movie on your Google TV and
then effortlessly continuing it on your phone during your commute -- that's the
power of Engage.

This new system is designed to boost viewer engagement and retention by
providing a smooth, frictionless experience across the entire Google ecosystem.

#### Is Video Discovery API the same as Engage?

Yes, they are the same. The Engage SDK is a library that includes support for
the continue watching row. Engage supports more content entity types than video,
which is why the integration is no longer named "Video Discovery".

#### What are the benefits of using Engage?

Answer: Engage makes it easier than ever for viewers to pick up where they left
off on your content, no matter what device they're using. Here's how it works:

- Seamless experience across Google: Start watching on your Google TV, and continue seamlessly on your Android phone, iPhone, or Android tablet. It even works on devices where you haven't installed the app yet!
- Increased engagement and retention: Engage helps bring users back to your app, even on new devices. By letting users resume their favorite shows, you increase the chances they'll keep watching.
- Wider reach: Beyond Google TV, Engage works across other Android media experiences, like Play Collections and other Google media apps.
- Backward compatible: If you're already using the older "[Watch Next](https://developer.android.com/training/tv/discovery/watch-next-add-programs)" feature, no problem! Engage is backward compatible, so your existing integration will still work.

Important Note: All new Continue Watching integrations must use Engage. The
older "Cross Device Play Next" system is being phased out.

#### What surfaces support Engage?

1. Google TV
2. Android TV (on-device only but supports Engage SDK)
3. Google TV Android mobile app
4. Google TV iOS mobile app
5. Play Collections
6. Google entertainment space
7. iOS devices (with REST API integration).

#### Is Engage SDK for Continue Watching?

Yes, the Engage SDK supports content for the continue watching row. It is
required to integrate with Engage.

#### Is Engage available for everyone?

Engage is being rolled out in phases.

- Early Access: We're initially granting access to a select group of partners through an Early Access Program (EAP).
- Expanding Access: We're working hard to make Engage available to all developers soon.

For a smooth and successful launch, we have safeguards in place to manage the
rollout. This involves both an allowlist on the Engage side and a separate check
within the Engage SDK. Whether you are an EAP partner or wants to be onboard
soon, please contact us so that we can set up the access permissions before you
begin with Engage SDK integration.

#### Is there a recommended image size we should provide?

Image requirements have been updated in the [Create Entities](https://developer.android.com/guide/playcore/engage/watch#image-specs)
section.

#### With this new API documentation, will the Continue Watching data pulled by the Google server from the client and will it be reflected in all the devices?

The new API offers significant improvements for content on the continue watching
row, including:

- **Seamless experience across Google TVs:** Users can start watching on one
  Google TV and resume on any other Google TV logged in with the same account.
  This feature also works with older Android TV versions.

- **Mobile app integration:** Content from Engage is surfaced on the Google TV
  mobile app for Android and iOS, allowing users to seamlessly switch between
  their TV and mobile devices.

- **Enhanced user retention:** Even on devices without the app installed or
  where the user isn't logged in, content in the continue watching row
  encourages users to re-engage with your app, boosting retention.

- **Expansion to other platforms:** Engage extends to other Google media
  platforms like Android, Play Collections, tablets, and other Google media
  apps \& surfaces on Android, maximizing user engagement across devices.

#### What is the limit on the number of entities I can publish to the Continuation cluster?

Each developer partner is limited to a maximum of 5 entities in the Continuation
cluster. This limit is for fair distribution of content on the "continue
watching" row on Google TV, which is a shared space for multiple media
providers.

#### What happens if I try to publish more than 5 entities?

Engage SDK will reject your publish request if it exceeds the 5-entity limit.
You'll need to reduce the number of entities in your request to successfully
publish. You should only include the entities where the users have left off
watching, so in most cases, there will be only a few such entities. When there
are more than 5 such entities, you could choose the more recent ones to publish.

#### Why is there a limit on the number of entities?

The continue watching row on Google TV displays content from various media
providers. Limiting the number of entities per provider so that users see a
diverse selection of content from all their favorite sources, promoting a fair
and balanced user experience.

### Verification App Questions

#### Is it mandatory to test my app with the verification app before submission?

Yes, testing your app with the verification app is essential before submitting
your APK.

While we understand you might be confident in your implementation, the Engage
integration has many intricate components. The verification app acts as a safety
net, catching potential issues early on and saving you valuable time and effort
in the long run.

Think of it as a quick checkup that helps guarantee a smooth launch and a great
user experience.

By identifying and addressing any problems beforehand, you can avoid the
frustration of rejections and resubmissions.

To submit your APK, you'll need to include a screenshot showing that your app
has passed the verification process.

#### What are some common mistakes to watch out for during integration?

The verification app is designed to catch potential issues with your Engage
integration. Here are some common mistakes that developers often encounter:

For all content types (movies, TV episodes, live streams, video clips):

- Missing Links: Make sure you provide valid platform-specific URIs (links) for your content. These links tell the system where to find your content on each platform.
- Missing Titles: Don't forget to include titles for all your content. This helps users identify what they were watching.
- Image Aspect Ratios: Verify all images associated with your content have an aspect ratio close to 16:9. This makes sure your images display correctly on different screens.

For TV Episodes:

- Complete Episode Information: Make sure to include the show title, episode number, and season number. This helps organize episodes and allows users to navigate within a series.
- Accurate Playback Position: Double-check that the last playback position is less than or equal to the total duration of the episode. This makes sure users resume from the correct spot.

For Movies:

- Accurate Playback Position: Similar to TV episodes, verify the last playback position is accurate.

For Live Streaming Videos:

- Broadcaster Information: Include the broadcaster's name for live streams.

For Video Clips:

- Creator Information: Specify the creator of the video clip.

Remember: The verification app will flag these issues, allowing you to fix them
before submitting your app. This saves you time and ensures a smoother
experience for your users.

### Account and Profile Questions

#### My app uses anonymous user logins. Is AccountProfile still required for Engage?

`AccountProfile` is designed for apps that use individual user accounts.
However, we understand that some apps, like yours, may rely on anonymous logins.
Here's how Engage works in this scenario:

- `AccountProfile` is technically required, but you can still integrate Engage even if your app doesn't have a user account system.
- Limited to on-device use: The cross-device capabilities of Engage relies on identifying users across different devices. Since anonymous logins don't provide this, the feature will be limited to the user's current device.
- How to configure: To set this up, you'll need to disable cross-device syncing. This makes sure that continuation entries only appear on the specific device where the content was started.

In summary: While you can integrate Engage with anonymous logins, users will
only be able to resume content on the same device.

#### Can I use AccountProfile with only `accountId` and no `profileId`, even when my app supports both accountId and `profileId`?

AccountProfile requires both `accountId` and `profileId` to function correctly.
Here's why:

- Consistent identification: `accountId` identifies the user, while `profileId` distinguishes between different profiles within that user's account (if applicable). Providing both makes sure that Engage accurately tracks and displays content for each individual profile.
- Preventing errors: Using `accountId` and `profileId` inconsistently across different API calls can lead to unexpected behavior and errors. For example, if you include both when adding content to Engage but only use `accountId` when deleting content, the system may not be able to correctly identify and remove the intended items.

#### Is `profileId` required for Engage?

- `accountId` is required. This identifies the user across devices.
- `profileId` is crucial for a good user experience. While technically optional, `profileId` is strongly recommended if your service supports multiple profiles (like many streaming services do). Why is it so important? Because without `profileId`, the continue watching row may show content from other profiles on the same account. This can lead to a confusing and frustrating experience for your users.
- In short: Providing `profileId` makes sure that content provided to the continue watching row accurately reflects each individual's viewing history. Unless your app doesn't support the concept of profile within an account, you should provide it.

#### How does Google use the `profileId` on their side?

If the service offers different profiles to watch content, `accountId` and
`profileId` would be used to associate the content watched on the device to the
signed-in Google Account on the device. Google would record the ContinueWatching
data against the combination of `accountId` and `profileId`. Any Google device
that has that same Google Account logged in, would get the latest updated data
from the same associated `accountId` and `profileId`, in its ContinueWatching
row.

#### Is account linking required to implement Engage?

Account Linking is not needed. It is being deprioritized and all related use
cases will be covered by the new Device Entitlements API.

### Sync Across Devices Questions

#### What does "sync across devices" mean when users give consent?

With the user's "sync across device" consent, the content they're watching will
be saved to Google TV servers, letting them seamlessly pick up where they left
off on any signed-in device. Without consent, their watch history remains local
to the current device.

#### Can we set "sync across devices" to false?

The `setUserConsentToSyncAcrossDevices` flag controls whether a user's
ContinuationCluster data is synchronized across their devices (TV, phone,
tablet, etc.). If this flag is set to false, then continue watching content is
only surfaced on same device.

To get the most out of our cross-device feature, we strongly advise your app to
obtain user consent and set SyncAcrossDevices to true.

#### How is user consent for sharing watch history obtained on non-Android

devices? What data points are shared to 3P servers from non-Android devices?

The consent is collected at the user level (profile or account level). Once
consent is obtained, the continue watching payloads based on engagement can be
sent anywhere so Google can reflect the users' ubiquity resumption state across
all entities that they have partial or next engagement with, on any device
(without having to re-ask consent on every device or platform). Partners will
send the users latest continue watching state (as per spec) associated with
profile ID (that was deposited on android).

### REST API Questions

#### Is there documentation on the REST API?

The ETA for REST API is March 2025, this is documented in Engage Developer Docs.

### Legacy Watch Next Questions

#### Is Engage replacing the Watch Next API?

Engage will be backward compatible on all Android TV devices that support the
Watch Next API. To integrate on Google TV and other surfaces that support
Engage, developers should use the Engage SDK.

### Testing and Integration Questions

#### What is the difference between LastPlayBackPositionTimeMillis and duration?

LastPlayBackPositionTimeMillis should reflect the playback duration in
milliseconds where the user stopped watching (e.g., 605000 ms for 10 minutes and
5 seconds). It should never be greater than the entity's total duration.

Whereas, **LastEngagementTime** is the timestamp when the user last engaged with
the content.

#### What are the test cases we should perform?

The following are test cases for Google TV that our QA performs. Similar test
cases can be performed on other surfaces as well.

1. Watch a video, which is longer than 20 minutes for about 5 minutes. Exit app. The video card should be displayed in the continue watching row. Note: We only display 5 cards per 3p app in CW
2. Selecting the newly appeared card in the continue watching row should continue playing the video from the right point in the video.Note: Any New or old content should resume playback from where it was left off last
3. Changing accounts on the GTV device should change the cards on the continue watching row. Only videos from the current account should show up. Sorted in recent order. 3p app profile CW will be intermixed. Note: CW for GoogleAccount2 will show 3P contents that GoogleAccount2 was engaged watching
4. Exit the app with BACK button \> Verify card is displayed in the "Continue watching" row
5. Hide the video in the continue watching row, it shouldn't show again Test if hidden content stays hidden beyond 24 hours and even after the app opens after 24 hrs. Confirm hiding one item does not hide multiple items.
6. Content availability in the continue watching row with full metadata: Card image, App name, title, season episode # for TV contents
7. Check Progress displays in the progress bar
8. User watched the content until ending credits - content does not display in the continue watching row
9. Confirm no unwatched items show up in the continue watching row
10. Confirm that the CW items are arranged chronologically based on when watch activity happened and not when the app was last opened or last day
11. Confirm that episode and season details on CW card match what was watched on episodic content
12. Confirm completed (items at credits or beyond) items don't show up in the continue watching row
13. Turn off the device halfway through watching the episode/movie/show. "Turn off the device halfway through watching the episode/movie/show. Verify on turning on the device and on other TV, CW displays the right card , at the right position and progress bar"
14. Turn off the device after completely watching episode 1, verify
15. episode 1 drops and doesn't reappear in continue watching row \[on second device and on turning on the test device\]
    1. episode 2 (if available), should appear in continue watching row \[on second device and on turning on the test device\]
16. First scenario: TV1: GoogleAccount: mom, 3p account / profile: account 1 / profile_1. Watch content and verify CW data displays contents watched by 3P account_1/profile_1
17. TV2: GoogleAccount: mom. Verify CW data from the first scenario. Now login
    to the 3p app as a different account. 3p account / profile: account_2 /
    profile_2. Watch content and verify CW data displays contents watched by 3p
    account_2/profile_2

18. GoogleAccount: mom. New device case /3P app not installed. On a new
    device(FDR the device), Verify CW displays data from the last used 3P app
    that was used by the GoogleAccount. Note: CW row shouldn't show 3P contents
    if the GAIA is not yet associated with a 3P profile on other device

    1. GoogleAccount: mom. New device case /3P app installed but not logged in. On a new device(FDR the device), Verify CW displays data from the last used 3P app that was used by the GoogleAccount.
19.

    > [!NOTE]
    > **Note:** When the app is installed and logged in, the CW state would reflect the active 3P user logged into the 3P app.

    1. Note: the continue watching row shouldn't show 3P contents if the GoogleAccount is not yet associated with a 3P profile

#### We are not seeing continuation content showing up on Google TV iOS app. What happened?

You will need to send iOS deeplinks for content to appear in the continue
watching row on iOS devices.

#### How often should I update content information for the continue watching row? Should I update it frequently, like every 15 seconds?

No, frequent updates are not recommended. Here's why:

- Performance Impact: Continuously sending updates puts unnecessary strain on our servers, potentially slowing down the system for everyone.
- Unnecessary Data: While a user is actively watching, their playback position changes constantly. Sending updates every few seconds creates a lot of redundant data that isn't helpful for resuming playback.

When to update content information for the continue watching row:

Focus on capturing meaningful changes in the user's viewing progress. Here are
the key scenarios:

- Playback Paused or Stopped: When a user pauses or stops watching, send an update to store their current position.
- App Closed or Backgrounded: If a user exits the app or switches to another app while watching a video, send an update to save their progress.
- When user removes an item from their continue watching row within app

How to efficiently update:

Instead of timed updates, utilize events within your video player or app
lifecycle to trigger updates. For example:

- `onPause`, `onStop`: When the video playback pauses or stops.
- `onAppClose`, `onAppBackgrounded`: When the app closes or moves to the background.

By following these guidelines, you'll ensure efficient use of resources while
still providing a seamless experience in the continue watching row for your
users.

> [!NOTE]
> **Note:** Please contact [`engage-developers@google.com`](mailto:engage-developers@google.com) if you have any questions that are not covered here.