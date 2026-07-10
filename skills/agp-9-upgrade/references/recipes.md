When migrating to AGP's new DSL, any Gradle code (plugins or logic in build
scripts) that relied on the old DSL will stop working. Such code must be
migrated.

## Guidelines

- **DO NOT** search the web for examples of how to do this. Use the **gradle-recipes** repository examples **only**.
- **DO NOT** use AGP internals in migrated code.
- **DO** use only public APIs in migrated code.

In some cases, there is a one-to-one replacement for the old code. Some examples
are in [the AGP 9.0.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes).

In other cases, there is no direct one-to-one replacement. For these situations,
the [gradle-recipes repo](https://github.com/android/gradle-recipes) is a great resource. You can checkout one of its
AGP 9.x branches, such as `agp-9.0`, `agp-9.1`, or `agp-9.2`. These branches
contain recipes for common situations in Android projects. The following table
lists the compatibility for recipes for each version of AGP.

## Compatibility table

| AGP version | gradle-recipes branch |
|---|---|
| 9.0.x | agp-9.0 |
| 9.1.x | agp-9.1 |
| 9.2.x | agp-9.2 |

## Recipes and use-cases

The following table links use-cases to recipes.

| Recipe | Use-case |
|---|---|
| addCustomBuildConfigFields | Add custom BuildConfig fields |
| listenToArtifacts | Rename APK |

Additional details for each use-case follow.

### Add custom BuildConfig fields

See the detailed guide at [BuildConfig](https://developer.android.com/agents/skills/build/agp/agp-9-upgrade/references/buildconfig).

### Renaming an APK

In the old DSL, an APK could be renamed very simply. Here's an example:

    android {
      applicationVariants.all {
        outputs.all {
          val output = this as com.android.build.gradle.api.ApkVariantOutput
          val fileName = output.outputFileName
          if (fileName.contains("release")) {
            output.outputFileName = "my-cool-new-name.apk"
          }
        }
      }
    }

However, with AGP 9 and the new DSL, `applicationVariants` is no longer
available. You must instead react to artifact creation using the
`androidComponents.onVariants` API. A complete example of this is available in
the **gradle-recipes** repository in the `listenToArtifacts` recipe.