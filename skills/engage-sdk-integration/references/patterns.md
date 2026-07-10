## EngageBroadcastReceiver

Setting up the `BroadcastReceiver` correctly requires **both** static and
dynamic registration. Static registration allows the app to receive broadcasts
even when it is not running, while dynamic registration is required on newer
Android versions to safely receive broadcasts when the app is live in memory.

### BroadcastReceiver Implementation


```kotlin
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import com.google.android.engage.service.BroadcastReceiverPermissions

class EngageBroadcastReceiver : BroadcastReceiver() {
    // IMPORTANT: Only trigger the specific publish job for the received intent action.
    // DO NOT publish all clusters at once.
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || context == null) return
        when (intent.action) {
            com.google.android.engage.service.Intents.ACTION_PUBLISH_RECOMMENDATION
            -> EngagePublisher.publishOneTime(context, Constants.PUBLISH_TYPE_RECOMMENDATIONS)
            // Note: If app handles other publish actions (e.g. Featured, Continuation), add them here.
            com.google.android.engage.service.Intents.ACTION_PUBLISH_FEATURED
            -> EngagePublisher.publishOneTime(context, Constants.PUBLISH_TYPE_FEATURED)

            /** Note: If vertical has other intents (e.g. FOOD shopping cart, etc.), add them here.
             * com.google.android.engage.food.service.Intents.ACTION_PUBLISH_FOOD_SHOPPING_CART
             * -> EngagePublisher.publishOneTime(context, Constants.PUBLISH_TYPE_FOOD_SHOPPING_CARD)
             * com.google.android.engage.travel.service.Intents.ACTION_PUBLISH_RESERVATION
             * -> EngagePublisher.publishOneTime(context, Constants.PUBLISH_TYPE_RESERVATION )
             **/
        }
    }

    companion object {
        /**
         * Dynamically registers the receiver.
         * This is required in addition to static registration in AndroidManifest.xml.
         * Call this method in your Application's onCreate() or your main Activity's onCreate().
         */
        fun register(context: Context) {
            val appContext = context.applicationContext
            val receiver = EngageBroadcastReceiver()

            // Register Cluster Publish Intents
            val filter = IntentFilter().apply {
                addAction(com.google.android.engage.service.Intents.ACTION_PUBLISH_RECOMMENDATION)
                addAction(com.google.android.engage.service.Intents.ACTION_PUBLISH_FEATURED)
                addAction(com.google.android.engage.service.Intents.ACTION_PUBLISH_CONTINUATION)
            }
            ContextCompat.registerReceiver(
                appContext,
                receiver,
                filter,
                BroadcastReceiverPermissions.BROADCAST_REQUEST_DATA_PUBLISH_PERMISSION,
                null,
                ContextCompat.RECEIVER_EXPORTED
            )
            // Note: Add vertical-specific intents here if applicable (e.g., FOOD shopping cart, etc.)
        }
    }
}
```

<br />

### Static Registration (AndroidManifest.xml)

Add the `<receiver>` tag inside the `<application>` block in
`AndroidManifest.xml`


```kotlin
<!--    Add the `<receiver>` tag inside the `<application>` block in `AndroidManifest.xml`:-->
<receiver
    android:name="com.example.snippets.engage.EngageBroadcastReceiver"
    android:permission="com.google.android.engage.REQUEST_ENGAGE_DATA"
    android:exported="true"
    android:enabled="true">
    <!-- Recommended for production TV APKs -->
    <intent-filter>
        <action android:name="com.google.android.engage.action.PUBLISH_RECOMMENDATION" />
        <action android:name="com.google.android.engage.action.PUBLISH_FEATURED" />
        <action android:name="com.google.android.engage.action.PUBLISH_CONTINUATION" />
        <!-- Note: Add vertical-specific intents here if applicable (e.g., FOOD shopping cart, etc.) -->
    </intent-filter>
</receiver>
```

<br />

## EngageWorker


```kotlin
import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.android.engage.service.AppEngageErrorCode
import com.google.android.engage.service.AppEngageException
import com.google.android.engage.service.AppEngagePublishClient
import com.google.android.engage.service.AppEngagePublishStatusCode
import com.google.android.engage.service.PublishStatusRequest
import com.google.android.gms.tasks.Task
import kotlinx.coroutines.tasks.await

class EngageWorker(context: Context, workerParams: WorkerParameters) : CoroutineWorker(context, workerParams) {
    // Replace {AppEngagePublishClient} with the "client" class found in references/schemas/{VERTICAL}.md.
    // Client class can vary based on app's vertical.
    // Refer to the references/schemas/{VERTICAL}.md to find the right class.
    // This is an example of using AppEngagePublishClient.
    private val client = AppEngagePublishClient(context)
    private val clusterRequestFactory = ClusterRequestFactory(context)

    override suspend fun doWork(): Result {
        if (runAttemptCount > Constants.MAX_PUBLISHING_ATTEMPTS) {
            // If we keep failing, report it as a service error before giving up.
            updatePublishStatus(AppEngagePublishStatusCode.NOT_PUBLISHED_SERVICE_ERROR)
            return Result.failure()
        }

        // Check if engage service is available before publishing.
        val isAvailable = client.isServiceAvailable.await()

        // If the service is not available, do not attempt to publish and indicate failure.
        if (!isAvailable) {
            return Result.failure()
        }

        val publishType = inputData.getString(Constants.PUBLISH_TYPE_KEY)
        return when (publishType) {
            Constants.PUBLISH_TYPE_RECOMMENDATIONS -> publishRecommendations()
            // Constants.PUBLISH_TYPE_FEATURED -> publishFeatured()
            Constants.PUBLISH_TYPE_CONTINUATION -> publishContinuation()
            Constants.PUBLISH_TYPE_USER_ACCOUNT_MANAGEMENT -> publishUserAccountManagement()
            else -> Result.failure()
        }
    }

    // Use similar patterns for other clusters (Featured, Continuation, FoodShoppingList, Reservation etc.)
    private suspend fun publishRecommendations(): Result {
        val publishTask: Task<Void> =
            client.publishRecommendationClusters(
                clusterRequestFactory.constructRecommendationClustersRequest()
            )
        return publishAndProvideResult(publishTask)
    }

    private suspend fun publishContinuation(): Result {
        // Empty Continuation Guard: If there is no continuation content,
        // we must delete the cluster instead of publishing an empty one on the UI.
        if (getContinuationData().isEmpty()) {
            val deleteTask = client.deleteContinuationCluster()
            return publishAndProvideResult(deleteTask)
        }

        val publishTask: Task<Void> =
            client.publishContinuationCluster(
                clusterRequestFactory.constructContinuationClusterRequest()
            )
        return publishAndProvideResult(publishTask)
    }

    private suspend fun publishUserAccountManagement(): Result {
        val publishTask: Task<Void>
        if (isAccountSignedIn()) {
            // If signed in, we delete the sign-in card.
            publishTask = client.deleteUserManagementCluster()
            return publishAndProvideResult(publishTask)
        } else {
            // If not signed in, we publish the sign-in card.
            // Note: Even though we are publishing a card, the status code is NOT_PUBLISHED_REQUIRES_SIGN_IN
            // because the actual content (recommendations/continuation) is not published.
            publishTask =
                client.publishUserAccountManagementRequest(
                    clusterRequestFactory.constructUserAccountManagementClusterRequest()
                )
            return try {
                publishTask.await()
                updatePublishStatus(AppEngagePublishStatusCode.NOT_PUBLISHED_REQUIRES_SIGN_IN)
                Result.success()
            } catch (publishException: Exception) {
                handlePublishException(publishException)
            }
        }
    }

    private fun isAccountSignedIn(): Boolean {
        // Implement your app's sign-in check logic here.
        // ...
    }

    private fun getContinuationData(): List<Any> {
        // Implement your app's data loading logic here.
        // ...
    }

    private suspend fun publishAndProvideResult(
        publishTask: Task<Void>
    ): Result {
        return try {
            // An AppEngageException may occur while publishing, so we may not be able to await the result.
            publishTask.await()
            // Update status to PUBLISHED only after successful publication.
            updatePublishStatus(AppEngagePublishStatusCode.PUBLISHED)
            Result.success()
        } catch (publishException: Exception) {
            handlePublishException(publishException)
        }
    }

    private fun handlePublishException(publishException: Exception): Result {
        val appEngageException = publishException as? AppEngageException
        if (appEngageException != null) {
            logPublishing(appEngageException)

            // Map AppEngageException error codes to PublishStatusCodes
            val errorStatusCode = when (appEngageException.errorCode) {
                AppEngageErrorCode.SERVICE_CALL_INVALID_ARGUMENT ->
                    AppEngagePublishStatusCode.NOT_PUBLISHED_CLIENT_ERROR

                AppEngageErrorCode.SERVICE_CALL_PERMISSION_DENIED ->
                    AppEngagePublishStatusCode.NOT_PUBLISHED_CLIENT_ERROR

                else ->
                    AppEngagePublishStatusCode.NOT_PUBLISHED_SERVICE_ERROR
            }
            updatePublishStatus(errorStatusCode)

            // Some errors are recoverable, such as a threading issue, some are unrecoverable
            // such as a cluster not containing all necessary fields. If an error is recoverable, we
            // should attempt to publish again. Setting the result to retry means WorkManager will
            // attempt to run the worker again, thus attempting to publish again.
            return if (isErrorRecoverable(appEngageException)) Result.retry() else Result.failure()
        }
        return Result.failure()
    }

    private fun updatePublishStatus(statusCode: Int) {
        client
            .updatePublishStatus(PublishStatusRequest.Builder().setStatusCode(statusCode).build())
            .addOnSuccessListener {
                Log.i(TAG, "Successfully updated publish status code to $statusCode")
            }
            .addOnFailureListener { exception ->
                Log.e(TAG, "Failed to update publish status code to $statusCode\n${exception.stackTrace}")
            }
    }

    private fun logPublishing(publishingException: AppEngageException) {
        val message = when (publishingException.errorCode) {
            AppEngageErrorCode.SERVICE_NOT_FOUND -> "Service not found"
            AppEngageErrorCode.SERVICE_CALL_EXECUTION_FAILURE -> "Execution failure"
            AppEngageErrorCode.SERVICE_NOT_AVAILABLE -> "Service not available"
            AppEngageErrorCode.SERVICE_CALL_PERMISSION_DENIED -> "Permission denied"
            AppEngageErrorCode.SERVICE_CALL_INVALID_ARGUMENT -> "Invalid argument"
            AppEngageErrorCode.SERVICE_CALL_INTERNAL -> "Internal error"
            AppEngageErrorCode.SERVICE_CALL_RESOURCE_EXHAUSTED -> "Resource exhausted"
            else -> "Unknown error"
        }
        Log.d(TAG, message)
    }

    private fun isErrorRecoverable(publishingException: AppEngageException): Boolean {
        return when (publishingException.errorCode) {
            // Recoverable Error codes
            AppEngageErrorCode.SERVICE_CALL_EXECUTION_FAILURE,
            AppEngageErrorCode.SERVICE_CALL_INTERNAL,
            AppEngageErrorCode.SERVICE_CALL_RESOURCE_EXHAUSTED -> true
            // Non recoverable error codes
            AppEngageErrorCode.SERVICE_NOT_FOUND,
            AppEngageErrorCode.SERVICE_CALL_INVALID_ARGUMENT,
            AppEngageErrorCode.SERVICE_CALL_PERMISSION_DENIED,
            AppEngageErrorCode.SERVICE_NOT_AVAILABLE -> false
            else -> false
        }
    }
}
```

<br />

## ClusterRequestFactory


```kotlin
class ClusterRequestFactory(context: Context) {

    // ...

    private val signInCard =
        com.google.android.engage.common.datamodel.SignInCardEntity.Builder()
            .addPosterImage(
                com.google.android.engage.common.datamodel.Image.Builder()
                    .setImageUri(Uri.parse("http://www.x.com/image.png"))
                    .setImageHeightInPixel(500)
                    .setImageWidthInPixel(500)
                    .build()
            )
            .setActionText(signInCardAction)
            .setActionUri(Uri.parse("https://xyz.com/signin"))
            .build()

    fun constructRecommendationClustersRequest(): com.google.android.engage.service.PublishRecommendationClustersRequest {

        val items = appDataRepository.getRecommendations()
        val recommendationCluster = com.google.android.engage.common.datamodel.RecommendationCluster.Builder()
            .setTitle("Recommended Content") // Required field
            .setRecommendationClusterType(com.google.android.engage.common.datamodel.RecommendationClusterType.TYPE_TOP_PICKS_FOR_YOU) // Required field
        for (item in items) {
            recommendationCluster.addEntity(ItemToEntityConverter.convert(item))
        }
        return com.google.android.engage.service.PublishRecommendationClustersRequest.Builder()
            .addRecommendationCluster(recommendationCluster.build())
            .setAccountProfile(accountProfile) // Set the account profile on the request for personalization/sync
            .build()
    }

    fun constructContinuationClusterRequest(): com.google.android.engage.service.PublishContinuationClusterRequest {
        val items = appDataRepository.getContinuationData()

        val continuationCluster = com.google.android.engage.common.datamodel.ContinuationCluster.Builder()
            .setAccountProfile(accountProfile) // Set the account profile on the request for personalization/sync

        for (item in items) {
            continuationCluster.addEntity(ItemToEntityConverter.convert(item))
        }
        return com.google.android.engage.service.PublishContinuationClusterRequest.Builder()
            .setContinuationCluster(continuationCluster.build())
            .build()
    }

    fun constructUserAccountManagementClusterRequest(): com.google.android.engage.service.PublishUserAccountManagementRequest =
        com.google.android.engage.service.PublishUserAccountManagementRequest.Builder()
            .setSignInCardEntity(signInCard)
            .build()
}
```

<br />

## EngagePublisher


```kotlin
object EngagePublisher {

    fun publishPeriodically(context: Context, publishType: String) {
        val workRequest = PeriodicWorkRequestBuilder<EngageWorker>(Constants.REPEAT_INTERVAL, TimeUnit.HOURS)
            .setInputData(workDataOf(Constants.PUBLISH_TYPE_KEY to publishType))
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("EngagePeriodic", ExistingPeriodicWorkPolicy.KEEP, workRequest)
    }

    fun publishOneTime(context: Context, publishType: String) {

        val workRequest = OneTimeWorkRequestBuilder<EngageWorker>()
            .setInputData(workDataOf(Constants.PUBLISH_TYPE_KEY to publishType))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("EngageOneTime", ExistingWorkPolicy.REPLACE, workRequest)
    }
}
```

<br />

## Constants


```kotlin
object Constants {
    // Holds common values like attempt counts, publish types etc.
    const val REPEAT_INTERVAL = 24L
    const val MAX_PUBLISHING_ATTEMPTS = 3
    const val PUBLISH_TYPE_KEY = "PUBLISH_TYPE"
    const val PUBLISH_TYPE_RECOMMENDATIONS = "RECOMMENDATIONS"
    const val PUBLISH_TYPE_FEATURED = "FEATURED"
    const val PUBLISH_TYPE_CONTINUATION = "CONTINUATION"
    // ...
    const val PUBLISH_TYPE_USER_ACCOUNT_MANAGEMENT = "USER_ACCOUNT_MANAGEMENT"
    // const val PUBLISH_TYPE_FOOD_SHOPPING_CARD = "FOOD_SHOPPING_CARD"
    // const val PUBLISH_TYPE_RESERVATION = "RESERVATION"
}
```

<br />

## ItemToEntityConverter


```kotlin
object ItemToEntityConverter {
    // Converts app's local models to appropriate engage entity models.
    // Use `{VERTICAL}.md` in the `references/schemas/` directory to identify the correct Engage entities.
    // This is an example of using EbookEntity model.
    fun convert(item: AppData): EbookEntity {
        return EbookEntity.Builder()
            // Implement required data mapping logic here.
            .setName(item.title)
            .addAuthor(item.author)
            .build()
    }
}
```

<br />

## Dependency Specifications (libs.versions.toml)

This skill specifies all dependencies following in `libs.versions.toml` format.
Adapt these definitions to other formats (such as standard Groovy `build.gradle`
or Kotlin DSL `build.gradle.kts` implementation lines) as required by the
project.

    [versions]
    engage-core = "1.5.12"
    engage-tv = "1.0.6"
    playServicesOssLicenses = "17.5.1"
    workManager = "2.11.2"
    coroutines = "1.10.2"

    [libraries]
    engage-core = { group = "com.google.android.engage", name = "engage-core", version.ref = "engage-core" }
    engage-tv = { group = "com.google.android.engage", name = "engage-tv", version.ref = "engage-tv" }
    play-services-oss-licenses = { group = "com.google.android.gms", name = "play-services-oss-licenses", version.ref = "playServicesOssLicenses" }
    androidx-work-runtime-ktx = { group = "androidx.work", name = "work-runtime-ktx", version.ref = "workManager" }
    androidx-work-testing = { group = "androidx.work", name = "work-testing", version.ref = "workManager" }
    kotlinx-coroutines-core = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-core", version.ref = "coroutines" }
    kotlinx-coroutines-play-services = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-play-services", version.ref = "coroutines" }
    kotlinx-coroutines-test = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-test", version.ref = "coroutines" }

## TV Integrations

The following patterns and configurations are specific to Android TV
integrations.

### AndroidManifest.xml (TV)


```kotlin
<!-- Mandatory for TV integrations -->
<uses-permission android:name="com.android.providers.tv.permission.WRITE_EPG_DATA" />
```

<br />

### PlatformSpecificUri Example


```kotlin
val platformSpecificPlaybackUris = listOf(
    com.google.android.engage.common.datamodel.PlatformSpecificUri.Builder()
        .setPlatformType(com.google.android.engage.common.datamodel.PlatformType.TYPE_ANDROID_TV)
        .setActionUri(Uri.parse("https://www.example.com/tv/play/123"))
        .build(),
    com.google.android.engage.common.datamodel.PlatformSpecificUri.Builder()
        .setPlatformType(com.google.android.engage.common.datamodel.PlatformType.TYPE_ANDROID_MOBILE)
        .setActionUri(Uri.parse("https://www.example.com/mobile/play/123"))
        .build()
)
```

<br />

### AccountProfile Example


```kotlin
val accountProfile: AccountProfile
    get() = AccountProfile.Builder()
        .setAccountId("user_123")
        .setProfileId("profile_456")
        // AppCompatDelegate.getApplicationLocales().get(0) for Per-App Language Preferences
        .setLocale(Locale.getDefault().toLanguageTag())
        .build()
```

<br />