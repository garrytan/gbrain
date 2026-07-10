When an Android module contains custom BuildConfig fields, the following steps
are necessary to ensure a correct build.

### Step 1: Enable the buildConfig build feature

In a build script:

    android {
      buildFeatures {
        buildConfig = true
      }
    }

In custom build-logic for an app module:

    extensions.configure<com.android.build.api.dsl.ApplicationExtension> {
      buildFeatures {
        buildConfig = true
      }
    }

In custom build-logic for a library module:

    extensions.configure<com.android.build.api.dsl.LibraryExtension> {
      buildFeatures {
        buildConfig = true
      }
    }

In custom build-logic using `CommonExtension`:

    extensions.configure<com.android.build.api.dsl.CommonExtension> {
      buildFeatures {
        buildConfig = true
      }
    }

### Step 2: Migrate to the new API

Use the **addCustomBuildConfigFields** recipe from the [gradle-recipes](https://developer.android.com/agents/skills/build/agp/agp-9-upgrade/references/recipes)
repository.

**IMPORTANT:** For `BuildConfigField`s with a type of `String`, the `value` field
*must* include quotation marks as part of the String. For example:

    BuildConfigField(
      type = "String",
      value = "\"Some value\"",
      comment = "Optional comment",
    )

It is an **error** if the `value` field doesn't include quotation marks as
part of the String. For example, `value = "Some value"` **is an error** . This is
because the `value` is written out literally.