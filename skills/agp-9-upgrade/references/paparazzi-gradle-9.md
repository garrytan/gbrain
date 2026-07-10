If Paparazzi is used in the project, update it to version 2.0.0-alpha04 or
higher.

Paparazzi version 2.0.0-alpha04 and lower is not fully compatible with Gradle
9, and Gradle 9 is required by AGP 9. This means that, without workarounds,
projects that use Paparazzi v2.0.0-alpha04 and lower cannot migrate to AGP 9.

At time of writing, there are no higher versions of Paparazzi. That is,
v2.0.0-alpha04 is the latest release.

The issue is due to Paparazzi using internal classes from Gradle that tend to
move in breaking ways without warning. This specific issue is related to HTML
test reports. To work around it, disable those HTML test reports. Here
are two examples of how to do this, one for Kotlin DSL and the other for Groovy
DSL. Any module that has the paparazzi plugin (`app.cash.paparazzi`) applied
must apply one of these two workarounds.

Kotlin DSL:

    tasks.withType<Test>().configureEach {
      // https://github.com/cashapp/paparazzi/issues/2111
      reports.html.required = false
    }

Groovy DSL:

    tasks.withType(Test).configureEach {
      // https://github.com/cashapp/paparazzi/issues/2111
      reports.html.required = false
    }