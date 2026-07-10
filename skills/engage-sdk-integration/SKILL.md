---
name: engage-sdk-integration
description: Helps developers integrate, debug, and resolve Play Engage SDK implementation
  issues. Use when adding Engage SDK support, generating publishing code, mapping
  data classes to entities, or fixing SDK-related errors.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-07-02'
  keywords:
  - android
  - engage
  - engage sdk
  - play engage library
  - google play
triggers:
  - android
  - jetpack
  - compose
---

This skill guides you through integrating the Play Engage SDK into an Android
app. It ensures that the code follows the mandatory structure and uses the
required Engage entities for each vertical.

## Workflow

Follow these steps to assist the developer:

1. **Identify Vertical and Cluster:**

   - Ask the developer which vertical their app belongs to based on **[references/schemas/](references/schemas)**.
   - Check if the integration is for TV or Mobile. Read the TV-specific sections in [patterns.md](references/patterns.md) as well if the integration is for TV.
   - Use `{VERTICAL}.md` in the **[references/schemas/](references/schemas)** directory to identify the corresponding Engage entities and the `client` class name. The `client` field in the JSON provides the full class name. (e.g., `com.google.android.engage.food.service.AppEngageFoodClient`).
   - **Note:** Initializing the client class requires a `Context` parameter (e.g., `AppEngageFoodClient(context)`).
   - Always refer to [common.md](references/common.md) for common entities.
   - Ask which cluster type they want to publish from the supported cluster types for that vertical.
   - Find the method to call from `{VERTICAL}.md` in the **[references/schemas/](references/schemas)** directory for the specified cluster. Each method will specify the request it expects.
   - Get the request structure from [requests.md](references/requests.md) and clusters from [clusters.md](references/clusters.md). Then suggest and use sources to fill the fields in the request structure correctly, along with the required entities and clusters.
2. **Generate Structured Boilerplate Code:**

   - Create a new directory for all Engage-related code. Name the directory to match the naming convention of the existing codebase.
   - Generate the following classes using templates in [patterns.md](references/patterns.md):
     - `Constants`: Holds constant values like attempt counts, publish types.
     - `ItemToEntityConverter`: Converts app's local models to Engage's Entity models.
     - `ClusterRequestFactory`: Constructs the publish requests.
     - `EngageWorker`: Handles the actual publishing and publish errors using WorkManager.
     - `EngagePublisher`: Orchestrates periodic and one-time jobs.
     - `EngageBroadcastReceiver`: Listens for AppEngageService intents and starts a one-time publish job from `EngagePublisher`. **Important** : Implement both **static registration** and **dynamic registration** patterns, including the companion object `register` method inside the `EngageBroadcastReceiver` class.
3. **Suggest Entity Mapping:**

   - Ask the developer to provide their local model schema(e.g., a data class or a JSON snippet).
   - If they haven't provided one, share entities from `{VERTICAL}.md` in the **[references/schemas/](references/schemas)** directory as a guide.
   - Once the local model is identified, suggest a mapping to the corresponding Engage entity.
   - Generate the conversion logic using the `ItemToEntityConverter` pattern in [patterns.md](references/patterns.md) and add it to the generated `{ENGAGE_CODE_DIR}/ItemToEntityConverter`
4. **Suggest Data Source:**

   - Ask the developer to provide the source of actual data you'll publish.
   - Once the source of data is identified, use the source of data to fetch data in app's local model schema.
   - Use `{ENGAGE_CODE_DIR}/ItemToEntityConverter` to convert this data to Engage entity.
   - Use obtained Engage entity model data with `{ENGAGE_CODE_DIR}/
     ClusterRequestFactory` to get cluster requests.
   - Call corresponding cluster publishing method obtained from `{VERTICAL}.md` in the **[references/schemas/](references/schemas)** directory with the obtained request in previous step in `{ENGAGE_CODE_DIR}/EngageWorker`.
5. **Gradle and Manifest Updates:**

   - Suggest updates to `build.gradle` and `AndroidManifest.xml`.
   - For mobile apps, use [patterns.md](references/patterns.md).
   - For TV apps, use the TV-specific sections in [patterns.md](references/patterns.md).
   - Provide the necessary `implementation` dependencies for `build.gradle` or `build.gradle.kts` from [patterns.md](references/patterns.md).
   - Provide the `<receiver>` and `<service>` declarations for `AndroidManifest.xml`.
   - Note: There's no separate import according to vertical except TV. For each vertical other than TV 'com.google.android.engage:engage-core:1.5.12' is enough.
6. **Debugging:**

   - Perform a Gradle sync.
   - If errors occur, follow this resolution order:
     - Fix import errors. For package `com.google.android.engage` or classes starting with `AppEngage`, verify the package name in the `{VERTICAL}.md` in **[references/schemas/](references/schemas)** directory or [common.md](references/common.md).
     - Fix any other errors.
   - Execute a full Gradle build and resolve any remaining compilation issues. Repeat this step until the Gradle build is successful.
7. **User Checklist:**
   At the end of code generation, notify the user to go through this checklist
   to verify that the integration is complete and as intended:
   \[ \] Verify that all the engage related files are created in
   `{ENGAGE_CODE_DIR}/`:
   - `Constants`
   - `ItemToEntityConverter`
   - `ClusterRequestFactory`
   - `EngageWorker`
   - `{cluster_type}Publisher`
   - `EngageBroadcastReceiver`
   \[ \] Verify that app's local model is converted to Engage entity by populating
   the fields correctly in the model in `{ENGAGE_CODE_DIR}/
   ItemToEntityConverter`.
   \[ \] Verify that `{ENGAGE_CODE_DIR}/EngageWorker` uses the data source
   identified in Step 4.
   \[ \] Verify that `EngageBroadcastReceiver.register(context)` is called within
   the `Application` class or `MainActivity` to register the receiver
   dynamically.
   \[ \] Verify that `AndroidManifest.xml` contains the static `<receiver>`
   declaration for `EngageBroadcastReceiver` with the necessary intent actions.

   - **Important** : Explicitly instruct the developer to call `EngageBroadcastReceiver.register(context)` inside their custom `Application` class `onCreate()` (or their main activity `onCreate()`) to dynamically register the receiver. Stress that **both** static and dynamic registrations are required for the integration to function.

## Reference Materials

- **FAQ:** [Engage FAQ](references/android/guide/playcore/engage/faq.md) - Refer to this document for answers to frequently
  asked questions from developers.

- **Vertical-Specific Guides:**

  - [Food Vertical](references/android/guide/playcore/engage/food.md)
  - [Watch Vertical](references/android/guide/playcore/engage/watch.md)
  - [Listen Vertical](references/android/guide/playcore/engage/listen.md)
  - [Read Vertical](references/android/guide/playcore/engage/read.md)
  - [Shopping Vertical](references/android/guide/playcore/engage/shopping.md)
  - [Social Vertical](references/android/guide/playcore/engage/social.md)
  - [Travel Vertical](references/android/guide/playcore/engage/travel.md)
  - [Health \& Fitness Vertical](references/android/guide/playcore/engage/healthandfitness.md)
  - [Other Verticals](references/android/guide/playcore/engage/otherverticals.md)
  - [TV Getting Started](references/android/guide/playcore/engage/tv/getting-started.md)
  - [TV Recommendations](references/android/guide/playcore/engage/tv/recommendations.md)
  - [TV Continue Watching](references/android/guide/playcore/engage/tv/continue-watching/index.md)
  - [TV Entitlements](references/android/guide/playcore/engage/tv/entitlements.md)
- **Vertical-Specific Schemas:**

  - [Food Schema](references/schemas/food.md)
  - [Watch Schema](references/schemas/watch.md)
  - [Listen Schema](references/schemas/listen.md)
  - [Read Schema](references/schemas/read.md)
  - [Shopping Schema](references/schemas/shopping.md)
  - [Social Schema](references/schemas/social.md)
  - [Travel Schema](references/schemas/travel.md)
  - [TV Schema](references/schemas/tv.md)
  - [Other Schema](references/schemas/other.md)

## Contract
- Inputs: Android project context and the skill's target surface (Compose, Play, profiling, security, etc.).
- Outputs: concrete, API-accurate Android guidance and code that matches official Android docs for the skill topic.
- Failure modes: outdated AGP/API assumptions, inventing SDK APIs, or applying mobile guidance to non-Android targets.

## Output Format
1. State the target Android surface and constraints.
2. Provide the minimal correct implementation or migration steps.
3. Call out version requirements, common pitfalls, and verification.

## Anti-Patterns
- Do not invent Jetpack/Play/Compose APIs or dependency coordinates.
- Do not hardcode secrets, signing keys, or production package names from examples into real apps.
- Do not skip version/AGP compatibility checks.
- Do not treat sample emails or demo identities as real credentials.
