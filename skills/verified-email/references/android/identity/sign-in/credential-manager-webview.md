This document describes how to integrate the Credential Manager API with an
Android app that uses WebView. Credential Manager is supported natively in the
`android.webkit.WebView` library in [version 1.12.0](https://developer.android.com/jetpack/androidx/releases/webkit#1.12.0) and later.

## Prerequisites

To use Credential Manager in WebView, add the following dependencies to your app
module's build script:

    dependencies {
      implementation("androidx.credentials:credentials:1.6.0-beta02")   
      implementation("androidx.credentials:credentials-play-services-auth:1.6.0-beta02")
      implementation("androidx.webkit:webkit:1.14.0")
    }

You will also need to associate your app with a website that your app owns using
digital asset linking. For more information, see
[adding digital asset linking](https://developer.android.com/identity/credential-manager/prerequisites).

## Use the WebKit library

To use the WebKit library, check for feature support, and then enable support by
calling `setWebAuthenticationSupport()`:

    class WebViewActivity : ComponentActivity() {
        override fun onCreate(savedInstanceState: Bundle?) {
            super.onCreate(savedInstanceState)
            setContent {
                // Put your webview link here.
                val url = "https://project-sesame-426206.appspot.com/passkey-signup"
                AndroidView(
                    factory = { context ->
                        WebView(context).apply {
                            settings.javaScriptEnabled = true

                            webViewClient = WebViewClientImpl()
                        }
                    },
                    update = { webView ->
                        run {
                            webView.loadUrl(url)
                            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
                                WebSettingsCompat.setWebAuthenticationSupport(
                                    webView.settings,
                                    WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP,
                                )
                                // Check if getWebauthenticationSupport may have been disabled by the WebView.
                                Log.e(
                                    "WebViewPasskeyDemo",
                                    "getWebAuthenticationSupport result: " + WebSettingsCompat.getWebAuthenticationSupport(
                                        webView.settings
                                    ),
                                )
                            } else {
                                Log.e("WebViewPasskeyDemo", "WebView does not support passkeys.")
                            }
                        }
                    },
                )
            }
        }
    }

> [!NOTE]
> **Note:** The WebKit library doesn't support `mediation:"conditional"` requests.

## Web integration

To learn how to build Web integration see
[Create a passkey for passwordless logins](https://web.dev/passkey-registration/).
You can also reference the [demo site source](https://github.com/deephand/webauthn-in-webview).

## Testing and deployment

Test the entire flow thoroughly in a controlled environment to verify proper
communication between the Android app, the web page, and the backend.

Deploy the integrated solution to production, verifying that the backend can
handle incoming registration and authentication requests. The backend code
should generate initial JSON for registration (create) and authentication (get)
processes. It should also handle validation and verification of the responses
received from the web page.

Verify the implementation corresponds to the [UX recommendations](https://developer.android.com/design/ui/mobile/guides/patterns/passkeys).