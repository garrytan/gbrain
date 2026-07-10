---
name: verified-email
description: Provides a complete workflow for implementing verified email retrieval
  on Android Credential Manager API. Use this skill to integrate a secure, OTP-less
  email verification flow into an Android app. This skill solves the problem of high-friction
  sign-up processes by leveraging cryptographically verified credentials from trusted
  providers like Google.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-07-02'
  keywords:
  - implementation
  - Android
  - Credential Manager
  - Digital Credentials
  - Verified Email
  - OpenID4VP
  - SD-JWT
  - OTP-less
  - authentication
  - passkeys
  - CredMan
  - identity.
triggers:
  - android
  - jetpack
  - compose
---

## Fundamentals

- *[Overview of Digital Credentials](references/android/identity/digital-credentials/email-verification.md)*: Learn about cryptographically verifiable documents and the role of Credential Manager.
- *[Glossary](references/android/identity/digital-credentials/email-verification-implementation.md)* : Definitions for `dcql_query`, `UserInfoCredential`, and `GetDigitalCredentialOption`.

### Standards \& Examples

- *[OpenID4VP Standard](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-introduction)*: The specification used to create digital credentials requests.
- *[Digital Credentials Demo](https://digital-credentials.dev/)*: Example requests and cross-platform testing tool.
- *[W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model-2.0/)*: The data model for cryptographically secured claims.
- *[SD-JWT](https://datatracker.ietf.org/doc/draft-ietf-oauth-selective-disclosure-jwt/)*: Selective Disclosure JSON Web Token format used for responses.
- *[mdoc](https://www.iso.org/standard/69084.html)*: ISO/IEC 18013-5 standard for mobile documents.

### Requirements

- **SDK Version**: Minimum SDK 28 (Android 9) is required.
- **GMS Version**: Google Play services version 25.49.x or higher.

### Use Cases

Email verification is applicable for the following use cases:

- **Account Creation/Sign-up**: Remove friction by skipping manual email verification.
- **Account Recovery**: Securely verify email ownership during recovery flows.
- **Re-authentication**: Versatile verification for high-risk actions, independent of the initial sign-in method.

### Limitations \& Nuances

- **Workspace Accounts**: Google does not issue verifiable credentials for Google Workspace Accounts.
- **Freshness**: For non-@gmail.com addresses, Google verifies the email at account creation but there is no freshness claim; implement an additional challenge like an OTP.

### Scope \& Pre-requisites

**Crucial** : This skill focuses exclusively on the **Android client-side
integration** . It does **not** implement the app's server-side cryptographic
validation logic. Server-side validation of the returned credential is required
for security and must be implemented in your backend.

## Codebase exploration for Use Cases

Get started with the following queries in project source code to find relevant
screens with different use cases to implement verified email:

- `SignUpScreen`
- `"Email address"`
- `"Recover Account"`
- `"Account Recovery"`
- `"Forgot password?"`
- `"Delete Account"`

## Identifying Integration Points

To implement this feature effectively, you must first locate the relevant
flows in your codebase. To initiate, start with the following strategies to
cater to different use cases using verified email:

### 1. Search for Navigation Routes

If your app uses Navigation, search for routes or destinations related
to authentication:

Look for:

- **Keywords** : `signup`, `registration`, `create_account`, `forgot_password`, `recovery`, `verify_email`.
- **Code Pattern** : Search for `NavHost` or `composable` destinations using these strings.

### 2. Locate Authentication ViewModels

Find the business logic handling user attributes and account creation, account
recovery:

- **Keywords** : `SignUpViewModel`, `AuthViewModel`, `RegistrationRepository`.
- **Code Pattern** : Look for methods like `onCreateAccount`, `onRecoverAccount`, or `validateEmail`.

### 3. Find instances of reauthentication for sensitive actions

For reauthentication use cases, find areas where users perform sensitive
actions:

- **Keywords** : `ChangePassword`, `UpdatePayment`, `DeleteAccount`, `UpdateDetails`, `EditUserDetails`

## Important pointers for Implementation

- Construct a Digital Credential Request and present it to the user.
- Make sure to follow the request JSON structure as mentioned in [documentation](references/android/identity/digital-credentials/email-verification-implementation.md).
- While presenting the request to the user, check if result credential is DigitalCredential and credential.credentialJson as responseJsonString
- Parse the response from the client.
- Offer a passkey creation option if one is not already present.
- Assume a local `SdJwtParser` to parse raw SD-JWT and return a `JSONObject`.
- Use a `VerifiedUserInfo` data class to store the parsed name and email.
- Leave a TODO for developers to handle the app's server-side validation and parsing.
- Direct users to the home screen after API call success and show a snackbar with user details for reference purpose only.

This guide describes how to implement verified email retrieval using the
[Digital Credentials Verifier API](references/android/identity/digital-credentials/credential-verifier.md) through an [OpenID for Verifiable
Presentations (OpenID4VP)](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html) request.

## Add dependencies

In your app's `build.gradle` file, add the following dependencies for Credential
Manager:

### Kotlin

```kotlin
dependencies {
    implementation("androidx.credentials:credentials:1.7.0-alpha02")
    implementation("androidx.credentials:credentials-play-services-auth:1.7.0-alpha02")
}
```

### Groovy

```groovy
dependencies {
    implementation "androidx.credentials:credentials:1.7.0-alpha02"
    implementation "androidx.credentials:credentials-play-services-auth:1.7.0-alpha02"
}
```

## Initialize Credential Manager

Use your app or activity context to create a `CredentialManager` object.

    // Use your app or activity context to instantiate a client instance of
    // CredentialManager.
    private val credentialManager = CredentialManager.create(context)

## Construct the Digital Credential request

To request a verified email, construct a [`GetCredentialRequest`](https://developer.android.com/reference/android/credentials/GetCredentialRequest)
containing a [`GetDigitalCredentialOption`](https://developer.android.com/reference/androidx/credentials/GetDigitalCredentialOption). This option requires a
`requestJson` string formatted as an OpenID for Verifiable Presentations
(OpenID4VP) request.

The OpenID4VP request JSON must follow a specific structure. The current
providers support a JSON structure with an outer `"digital": {"requests":
[...]}` wrapper.

        val nonce = generateSecureRandomNonce()

        // This request follows the OpenID4VP spec
        val openId4vpRequest = """
    {
      "requests": [
        {
          "protocol": "openid4vp-v1-unsigned",
          "data": {
            "response_type": "vp_token",
            "response_mode": "dc_api",
            "nonce": "$nonce",
            "dcql_query": {
              "credentials": [
                {
                  "id": "user_info_query",
                  "format": "dc+sd-jwt",
                   "meta": { 
                      "vct_values": ["UserInfoCredential"] 
                   },
                  "claims": [ 
                    {"path": ["email"]}, 
                    {"path": ["name"]},  
                    {"path": ["given_name"]},
                    {"path": ["family_name"]},
                    {"path": ["picture"]},
                    {"path": ["hd"]},
                    {"path": ["email_verified"]}
                  ]
                }
              ]
            }
          }
        }
      ]
    }
    """

        val getDigitalCredentialOption = GetDigitalCredentialOption(requestJson = openId4vpRequest)
        val request = GetCredentialRequest(listOf(getDigitalCredentialOption))

The request contains the following key information:

- **DCQL query** : The `dcql_query` specifies the credential type and the
  claims being requested (`email_verified`). You can request other claims to
  determine the level of verification. A few possible claims are as follows:

  - `email_verified`: In the response, this is a Boolean that indicates whether the email is verified.
  - `hd` (hosted domain): In the response, this is empty.

  > [!NOTE]
  > **Note:** If `email_verified` is `true` and `hd` is empty in the response, it implies that the account is an authorized Google Account. Google does not issue [verifiable credentials](references/android/identity/digital-credentials/index.md) for Google Workspace Accounts. However, the `hd` field is present in verifiable credentials issued for non-workspace accounts. You are encouraged to implement handling this field to future-proof your app. If the email is non-@gmail.com, Google verified this email when the Google Account was created, but there is no freshness claim. Therefore, for non-Google emails, you should consider an additional challenge, such as an OTP, to verify the user. To understand the schema of the credential and the specific rules for validating fields like `email_verified`, refer to the [Google
  > Identity guides](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

- **nonce**: A unique, cryptographically secure random value is generated for
  each request. This is critical for security, as it prevents replay attacks.

- `UserInfoCredential`: This value implies a specific type of digital
  credential that contains user attributes. Including this in the request is
  pivotal to distinguish the email verification use case.

Next, wrap the `openId4vpRequest` JSON in a `GetDigitalCredentialOption`, create
a `GetCredentialRequest`, and call `getCredential()`.

> [!NOTE]
> **Note:** The `hd` and `email_verified` fields are hidden from users in Credential Manager's built-in UI. You cannot make a request with only these hidden fields- in case of such requests, the response is the [`GetCredentialCancellationException`](https://developer.android.com/reference/kotlin/androidx/credentials/exceptions/GetCredentialCancellationException).

## Present the request to the user

Present the user with the request, using the Credential Manager built-in UI.

    try {
        // Requesting Digital Credential from user...
        val result = credentialManager.getCredential(activity, request)

        when (val credential = result.credential) {
            is DigitalCredential -> {
                val responseJsonString = credential.credentialJson

                // Successfully received digital credential response.

                // Next, parse this response and send it to your server.
                // ...
            }

            else -> {
                // handle Unexpected State() - Up to the developer
            }
        }
    } catch (e: Exception) {
        // handle exceptions - Up to the developer
    }

> [!NOTE]
> **Note:** There is no equivalent of Sign in with Google's `preferImmediatelyAvailableCredentials` for Digital Credentials. If no verifiable credential is found (for example, no eligible account on device), the user will be shown a "No options available" or similar system screen.

## Parse the response on the client

After receiving the response, you can perform a preliminary parse on the client.
This is useful for immediately updating the UI, for example, by showing the
user's name.

> [!IMPORTANT]
> **Important:** This step is not for validation. Full cryptographic verification must be performed on your server.

The following code extracts the raw [Selective Disclosure JWT
(SD-JWT)](https://datatracker.ietf.org/doc/rfc9901/) and uses a helper to decode its claims.

    // 1. Parse the outer JSON wrapper to get the `vp_token`
    val responseData = JSONObject(responseJsonString)
    val vpToken = responseData.getJSONObject("vp_token")

    // 2. Extract the raw SD-JWT string
    val credentialId = vpToken.keys().next()
    val rawSdJwt = vpToken.getJSONArray(credentialId).getString(0)

    // 3. Use your parser to get the verified claims
    // Server-side validation/parsing is highly recommended.

    // Assumes a local parser like the one in our SdJwtParser.kt sample
    val claims = SdJwtParser.parse(rawSdJwt)
    Log.d("TAG", "Parsed Claims: ${claims.toString(2)}")

    // 4. Create your VerifiedUserInfo object with REAL data
    val userInfo = VerifiedUserInfo(
        email = claims.getString("email"),
        displayName = claims.optString("name", claims.getString("email"))
    )

## Handle the response

The Credential Manager API will return a [`DigitalCredential`](https://developer.android.com/reference/androidx/credentials/DigitalCredential)
response.

The following is an example of what the raw `responseJsonString` looks like, and
what the claims look like after parsing the inner SD-JWT where you get
additional metadata as well along with verified email:

    /*
    // Example of the raw JSON response from credential.credentialJson:
    {
      "vp_token": {
        // This key matches the 'id' you set in your dcql_query
        "user_info_query": [
          // The SD-JWT string (Issuer JWT ~ Disclosures ~ Key Binding JWT)
          "eyJhbGciOiJ...~WyI...IiwgImVtYWlsIiwgInVzZXJAZXhhbXBsZS5jb20iXQ~...~eyJhbGciOiJ..."
        ]
      }
    }

    // Example of the parsed and verified claims from the SD-JWT on your server:
    {
      "cnf": {
        "jwk": {..}
      },
      "exp": 1775688222,
      "iat": 1775083422,
      "iss": "https://verifiablecredentials-pa.googleapis.com",
      "vct": "UserInfoCredential",
      "email": "jane.doe@example.com",
      "email_verified": true,
      "given_name": "Jane",
      "family_name": "Doe",
      "name": "Jane Doe",
      "picture": "http://example.com/janedoe/me.jpg",
      "hd": ""
    }
     */

> [!IMPORTANT]
> **Important:** We highly recommend that after receiving the verified email, you trigger Credential Manager's [passkey creation](https://developer.android.com/identity/credential-manager/passkeys/create-passkeys).

## Server-side validation for account creation

Since the retrieved email is cryptographically verified, you can omit the email
OTP verification step, significantly reducing sign-up friction and potentially
increasing conversion. This process is best handled on your server. The client
sends the raw response (containing the `vp_token`) and the original nonce to a
new server endpoint.

For verification, your application must send the full `responseJsonString` to
your server for cryptographic validation before creating an account or logging
the user in.

The digital credential provides two critical levels of verification for your
server:

- **Authenticity of the data** : Verifying the issuer (`iss`) URL and the `SD-JWT` signature proves that a trusted authority issued this data.
- **Identity of the presenter** : Verifying the `cnf` field and the Key Binding (`kb`) signature confirms that the credential is being shared by the same device it was originally issued to, preventing it from being intercepted or used on another device.

The validation on the server must achieve the following:

- **Verify issuer** : Ensure the `iss` (issuer) field matches `https://verifiablecredentials-pa.googleapis.com`.
- **Verify signature**: Check the signature of the SD-JWT using the public keys (JWKs) available at https://verifiablecredentials-pa.googleapis.com/.well-known/vc-public-jwks.

> [!NOTE]
> **Note:** Use a standard library (such as [@sd-jwt/sd-jwt-vc](https://datatracker.ietf.org/doc/rfc9901/) for Node.js) to perform the verification steps as outlined in the [OpenID for Verifiable
> Presentations specification](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html).

For full security, make sure that you also validate the `nonce` to prevent
replay attacks.

By combining these steps, your server can validate both the authenticity of the
data and the identity of the presenter, ensuring the credential wasn't
intercepted or spoofed before provisioning the new account.

    try {
        // Send the raw credential response and the original nonce to your server.
        // Your server must validate the response. createAccountWithVerifiedCredentials
        // is a custom implementation per each RP for server side verification and account creation.
        val serverResponse = createAccountWithVerifiedCredentials(responseJsonString, nonce)

        // Server returns the new account info (e.g., email, name)
        val claims = JSONObject(serverResponse.json)

        val userInfo = VerifiedUserInfo(
            email = claims.getString("email"),
            displayName = claims.optString("name", claims.getString("email"))
        )

        // handle response - Up to the developer
    } catch (e: Exception) {
        // handle exceptions - Up to the developer
    }

## Passkey creation

An optional but highly recommended next step after provisioning an account is to
immediately [create a passkey](references/android/identity/passkeys/create-passkeys.md) for that account. This provides a secure,
passwordless method for the user to sign in. This flow is identical to a
standard passkey registration.

## WebView support

For the flow to work on a [`WebView`](https://developer.android.com/reference/android/webkit/WebView), developers should implement a
[JavaScript bridge](references/android/identity/sign-in/credential-manager-webview.md) (JS Bridge) to facilitate the handoff. This bridge
allows the `WebView` object to signal the native app, which can then perform the
actual call to the Credential Manager API.

## See also

- [Overview of verified email retrieval](references/android/identity/digital-credentials/email-verification.md)
- [Credential Manager](references/android/identity/credential-manager/index.md)

## Critical Security Guidelines

To maintain the integrity of the email verification flow, the following security
requirements are mandatory:

- **Server-side Validation** : Never trust claims parsed on the client for security-sensitive operations like account creation. Send the complete, raw `responseJsonString` and the original `nonce` to the app's server for full verification.
- **Nonce Integrity** : Generate a unique, cryptographically secure nonce for every request and **never** reuse a nonce across multiple requests to prevent replay attacks.
- **Cryptographic Checks** : The app's server must validate the issuer (`iss`) field, the SD-JWT signature, and the presenter identity using the `cnf` field.

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
