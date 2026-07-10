# Deep Link Basic Recipe

This recipe demonstrates how to parse a deep link URL from an Android Intent into a Navigation key.

## How it works

It consists of two activities - `CreateDeepLinkActivity` to construct and trigger the deeplink request, and the `MainActivity` to show how an app can handle that request.

## Demonstrated forms of deeplink

The `MainActivity` has several backStack keys to demonstrate different types of supported deeplinks:

1. `HomeKey` - deeplink with an exact url (no deeplink arguments)
2. `UsersKey` - deeplink with path arguments
3. `SearchKey` - deeplink with query arguments

See `MainActivity.deepLinkPatterns` for the actual url pattern of each.

## Recipe structure

This recipe consists of three main packages:

1. `basic.deeplink` - Contains the two activities
2. `basic.deeplink.ui` - Contains the activity UI code, i.e. global string variables, deeplink URLs etc
3. `basic.deeplink.util` - Contains the classes and helper methods to parse and match the deeplinks

[![](https://developer.android.com/static/images/picto-icons/code.svg) Explore View the full recipe on GitHub.](https://github.com/android/nav3-recipes/tree/main/app/src/main/java/com/example/nav3recipes/deeplink/basic)

```
package com.example.nav3recipes.deeplink.basic

import androidx.navigation3.runtime.NavKey
import com.example.nav3recipes.deeplink.basic.ui.STRING_LITERAL_FILTER
import com.example.nav3recipes.deeplink.basic.ui.STRING_LITERAL_HOME
import com.example.nav3recipes.deeplink.basic.ui.STRING_LITERAL_SEARCH
import com.example.nav3recipes.deeplink.basic.ui.STRING_LITERAL_USERS
import kotlinx.serialization.Serializable

internal interface NavRecipeKey: NavKey {
    val name: String
}

@Serializable
internal object HomeKey: NavRecipeKey {
    override val name: String = STRING_LITERAL_HOME
}

@Serializable
internal data class UsersKey(
    val filter: String,
): NavRecipeKey {
    override val name: String = STRING_LITERAL_USERS
    companion object {
        const val FILTER_KEY = STRING_LITERAL_FILTER
        const val FILTER_OPTION_RECENTLY_ADDED = "recentlyAdded"
        const val FILTER_OPTION_ALL = "all"
    }
}

@Serializable
internal data class SearchKey(
    val firstName: String? = null,
    val ageMin: Int? = null,
    val ageMax: Int? = null,
    val location: String? = null,
): NavRecipeKey {
    override val name: String = STRING_LITERAL_SEARCH
}
```

```
package com.example.nav3recipes.deeplink.basic

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.net.toUri
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.example.nav3recipes.common.deeplink.EntryScreen
import com.example.nav3recipes.common.deeplink.FriendsList
import com.example.nav3recipes.common.deeplink.LIST_USERS
import com.example.nav3recipes.common.deeplink.TextContent
import com.example.nav3recipes.deeplink.basic.ui.URL_HOME_EXACT
import com.example.nav3recipes.deeplink.basic.ui.URL_SEARCH
import com.example.nav3recipes.deeplink.basic.ui.URL_USERS_WITH_FILTER
import com.example.nav3recipes.deeplink.basic.util.DeepLinkMatchResult
import com.example.nav3recipes.deeplink.basic.util.DeepLinkMatcher
import com.example.nav3recipes.deeplink.basic.util.DeepLinkPattern
import com.example.nav3recipes.deeplink.basic.util.DeepLinkRequest
import com.example.nav3recipes.deeplink.basic.util.KeyDecoder
import com.example.nav3recipes.ui.setEdgeToEdgeConfig

/**
 * Parses a target deeplink into a NavKey. There are several crucial steps involved:
 *
 * STEP 1.Parse supported deeplinks (URLs that can be deeplinked into) into a readily readable
 *  format (see [DeepLinkPattern])
 * STEP 2. Parse the requested deeplink into a readily readable, format (see [DeepLinkRequest])
 *  **note** the parsed requested deeplink and parsed supported deeplinks should be cohesive with each
 *  other to facilitate comparison and finding a match
 * STEP 3. Compare the requested deeplink target with supported deeplinks in order to find a match
 *  (see [DeepLinkMatchResult]). The match result's format should enable conversion from result
 *  to backstack key, regardless of what the conversion method may be.
 * STEP 4. Associate the match results with the correct backstack key
 *
 * This recipes provides an example for each of the above steps by way of kotlinx.serialization.
 *
 * **This recipe is designed to focus on parsing an intent into a key, and therefore these additional
 * deeplink considerations are not included in this scope**
 *  - Create synthetic backStack
 *  - Multi-modular setup
 *  - DI
 *  - Managing TaskStack
 *  - Up button ves Back Button
 *
 */
class MainActivity : ComponentActivity() {
    /** STEP 1. Parse supported deeplinks */
    // internal so that landing activity can link to this in the kdocs
    internal val deepLinkPatterns: List<DeepLinkPattern<out NavKey>> = listOf(
        // "https://www.nav3recipes.com/home"
        DeepLinkPattern(HomeKey.serializer(), (URL_HOME_EXACT).toUri()),
        // "https://www.nav3recipes.com/users/with/{filter}"
        DeepLinkPattern(UsersKey.serializer(), (URL_USERS_WITH_FILTER).toUri()),
        // "https://www.nav3recipes.com/users/search?{firstName}&{age}&{location}"
        DeepLinkPattern(SearchKey.serializer(), (URL_SEARCH.toUri())),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)

        // retrieve the target Uri
        val uri: Uri? = intent.data
        // associate the target with the correct backstack key
        val key: NavKey = uri?.let {
            /** STEP 2. Parse requested deeplink */
            val request = DeepLinkRequest(uri)
            /** STEP 3. Compared requested with supported deeplink to find match*/
            val match = deepLinkPatterns.firstNotNullOfOrNull { pattern ->
                DeepLinkMatcher(request, pattern).match()
            }
            /** STEP 4. If match is found, associate match to the correct key*/
            match?.let {
                   //leverage kotlinx.serialization's Decoder to decode
                   // match result into a backstack key
                    KeyDecoder(match.args)
                        .decodeSerializableValue(match.serializer)
            }
        } ?: HomeKey // fallback if intent.uri is null or match is not found

        /**
         * Then pass starting key to backstack
         */
        setContent {
            val backStack: NavBackStack<NavKey> = rememberNavBackStack(key)
            NavDisplay(
                backStack = backStack,
                onBack = { backStack.removeLastOrNull() },
                entryProvider = entryProvider {
                    entry<HomeKey> { key ->
                        EntryScreen(key.name) {
                            TextContent("<matches exact url>")
                        }
                    }
                    entry<UsersKey> { key ->
                        EntryScreen("${key.name} : ${key.filter}") {
                            TextContent("<matches path argument>")
                            val list = when {
                                key.filter.isEmpty() -> LIST_USERS
                                key.filter == UsersKey.FILTER_OPTION_ALL -> LIST_USERS
                                else -> LIST_USERS.take(5)
                            }
                            FriendsList(list)
                        }
                    }
                    entry<SearchKey> { search ->
                        EntryScreen(search.name) {
                            TextContent("<matches query parameters, if any>")
                            val matchingUsers = LIST_USERS.filter { user ->
                                (search.firstName == null || user.firstName == search.firstName) &&
                                        (search.location == null || user.location == search.location) &&
                                        (search.ageMin == null || user.age >= search.ageMin) &&
                                        (search.ageMax == null || user.age <= search.ageMax)
                            }
                            FriendsList(matchingUsers)
                        }
                    }
                }
            )
        }
    }
}
```

```
package com.example.nav3recipes.deeplink.basic

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import androidx.lifecycle.compose.dropUnlessResumed
import com.example.nav3recipes.common.deeplink.EMPTY
import com.example.nav3recipes.common.deeplink.EntryScreen
import com.example.nav3recipes.common.deeplink.FIRST_NAME_JOHN
import com.example.nav3recipes.common.deeplink.FIRST_NAME_JULIE
import com.example.nav3recipes.common.deeplink.FIRST_NAME_MARY
import com.example.nav3recipes.common.deeplink.FIRST_NAME_TOM
import com.example.nav3recipes.common.deeplink.LOCATION_BC
import com.example.nav3recipes.common.deeplink.LOCATION_BR
import com.example.nav3recipes.common.deeplink.LOCATION_CA
import com.example.nav3recipes.common.deeplink.LOCATION_US
import com.example.nav3recipes.common.deeplink.MenuDropDown
import com.example.nav3recipes.common.deeplink.MenuTextInput
import com.example.nav3recipes.common.deeplink.PaddedButton
import com.example.nav3recipes.common.deeplink.TextContent
import com.example.nav3recipes.deeplink.basic.ui.PATH_BASE
import com.example.nav3recipes.deeplink.basic.ui.PATH_INCLUDE
import com.example.nav3recipes.deeplink.basic.ui.PATH_SEARCH
import com.example.nav3recipes.deeplink.basic.ui.STRING_LITERAL_HOME
import com.example.nav3recipes.ui.setEdgeToEdgeConfig

/**
 * This activity allows the user to create a deep link and make a request with it.
 *
 * **HOW THIS RECIPE WORKS** it consists of two activities - [CreateDeepLinkActivity] to construct
 * and trigger the deeplink request, and the [MainActivity] to show how an app can handle
 * that request.
 *
 * **DEMONSTRATED FORMS OF DEEPLINK** The [MainActivity] has a several backStack keys to
 * demonstrate different types of supported deeplinks:
 * 1. [HomeKey] - deeplink with an exact url (no deeplink arguments)
 * 2. [UsersKey] - deeplink with path arguments
 * 3. [SearchKey] - deeplink with query arguments
 * See [MainActivity.deepLinkPatterns] for the actual url pattern of each.
 *
 * **RECIPE STRUCTURE** This recipe consists of three main packages:
 * 1. basic.deeplink - Contains the two activities
 * 2. basic.deeplink.ui - Contains the activity UI code, i.e. global string variables, deeplink URLs etc
 * 3. basic.deeplink.util - Contains the classes and helper methods to parse and match
 * the deeplinks
 *
 * See [MainActivity] for how the requested deeplink is handled.
 */
class CreateDeepLinkActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        setEdgeToEdgeConfig()
        super.onCreate(savedInstanceState)

        setContent {
            /**
             * UI for deeplink sandbox
             */
            EntryScreen("Sandbox - Build Your Deeplink") {
                TextContent("Base url:\n${PATH_BASE}/")
                var showFilterOptions by remember { mutableStateOf(false) }
                val selectedPath = remember { mutableStateOf(MENU_OPTIONS_PATH[KEY_PATH]?.first()) }

                var showQueryOptions by remember { mutableStateOf(false) }
                var selectedFilter by remember { mutableStateOf("") }
                val selectedSearchQuery = remember { mutableStateMapOf<String, String>() }

                // manage path options
                MenuDropDown(
                    menuOptions = MENU_OPTIONS_PATH,
                ) { _, selection ->
                    selectedPath.value = selection
                    when (selection) {
                        PATH_SEARCH -> {
                            showQueryOptions = true
                            showFilterOptions = false
                        }

                        PATH_INCLUDE -> {
                            showQueryOptions = false
                            showFilterOptions = true
                        }

                        else -> {
                            showQueryOptions = false
                            showFilterOptions = false
                        }
                    }
                }

                // manage path filter options, reset state if menu is closed
                LaunchedEffect(showFilterOptions) {
                    selectedFilter = if (showFilterOptions) {
                        MENU_OPTIONS_FILTER.values.first().first()
                    } else {
                        ""
                    }
                }
                if (showFilterOptions) {
                    MenuDropDown(
                        menuOptions = MENU_OPTIONS_FILTER,
                    ) { _, selected ->
                        selectedFilter = selected
                    }
                }

                // manage query options, reset state if menu is closed
                LaunchedEffect(showQueryOptions) {
                    if (showQueryOptions) {
                        val initEntry = MENU_OPTIONS_SEARCH.entries.first()
                        selectedSearchQuery[initEntry.key] = initEntry.value.first()
                    } else {
                        selectedSearchQuery.clear()
                    }
                }
                if (showQueryOptions) {
                    MenuTextInput(
                        menuLabels = MENU_LABELS_SEARCH,
                    ) { label, selected ->
                        selectedSearchQuery[label] = selected
                    }
                    MenuDropDown(
                        menuOptions = MENU_OPTIONS_SEARCH,
                    ) { label, selected ->
                        selectedSearchQuery[label] = selected
                    }
                }

                // form final deeplink url
                val arguments = when (selectedPath.value) {
                    PATH_INCLUDE -> "/${selectedFilter}"
                    PATH_SEARCH -> {
                        buildString {
                            selectedSearchQuery.forEach { entry ->
                                if (entry.value.isNotEmpty()) {
                                    val prefix = if (isEmpty()) "?" else "&"
                                    append("$prefix${entry.key}=${entry.value}")
                                }
                            }
                        }
                    }

                    else -> ""
                }
                val finalUrl = "${PATH_BASE}/${selectedPath.value}$arguments"
                TextContent("Final url:\n$finalUrl")
                // deeplink to target
                PaddedButton("Deeplink Away!", onClick = dropUnlessResumed {
                    val intent = Intent(
                        this@CreateDeepLinkActivity,
                        MainActivity::class.java
                    )
                    // start activity with the url
                    intent.data = finalUrl.toUri()
                    startActivity(intent)
                })
            }
        }
    }
}

private const val KEY_PATH = "path"
private val MENU_OPTIONS_PATH = mapOf(
    KEY_PATH to listOf(
        STRING_LITERAL_HOME,
        PATH_INCLUDE,
        PATH_SEARCH,
    ),
)

private val MENU_OPTIONS_FILTER = mapOf(
    UsersKey.FILTER_KEY to listOf(UsersKey.FILTER_OPTION_RECENTLY_ADDED, UsersKey.FILTER_OPTION_ALL),
)

private val MENU_OPTIONS_SEARCH = mapOf(
    SearchKey::firstName.name to listOf(
        EMPTY,
        FIRST_NAME_JOHN,
        FIRST_NAME_TOM,
        FIRST_NAME_MARY,
        FIRST_NAME_JULIE
    ),
    SearchKey::location.name to listOf(EMPTY, LOCATION_CA, LOCATION_BC, LOCATION_BR, LOCATION_US)
)

private val MENU_LABELS_SEARCH = listOf(SearchKey::ageMin.name, SearchKey::ageMax.name)

```

```
package com.example.nav3recipes.deeplink.basic.util

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.AbstractDecoder
import kotlinx.serialization.encoding.CompositeDecoder
import kotlinx.serialization.modules.EmptySerializersModule
import kotlinx.serialization.modules.SerializersModule

/**
 * Decodes the list of arguments into a a back stack key
 *
 * **IMPORTANT** This decoder assumes that all argument types are Primitives.
 */
@OptIn(ExperimentalSerializationApi::class)
internal class KeyDecoder(
    private val arguments: Map<String, Any>,
) : AbstractDecoder() {

    override val serializersModule: SerializersModule = EmptySerializersModule()
    private var elementIndex: Int = -1
    private var elementName: String = ""

    /**
     * Decodes the index of the next element to be decoded. Index represents a position of the
     * current element in the [descriptor] that can be found with [descriptor].getElementIndex.
     *
     * The returned index will trigger deserializer to call [decodeValue] on the argument at that
     * index.
     *
     * The decoder continually calls this method to process the next available argument until this
     * method returns [CompositeDecoder.DECODE_DONE], which indicates that there are no more
     * arguments to decode.
     *
     * This method should sequentially return the element index for every element that has its value
     * available within [arguments].
     */
    override fun decodeElementIndex(descriptor: SerialDescriptor): Int {
        var currentIndex = elementIndex
        while (true) {
            // proceed to next element
            currentIndex++
            // if we have reached the end, let decoder know there are not more arguments to decode
            if (currentIndex >= descriptor.elementsCount) return CompositeDecoder.DECODE_DONE
            val currentName = descriptor.getElementName(currentIndex)
            // Check if bundle has argument value. If so, we tell decoder to process
            // currentIndex. Otherwise, we skip this index and proceed to next index.
            if (arguments.contains(currentName)) {
                elementIndex = currentIndex
                elementName = currentName
                return elementIndex
            }
        }
    }

    /**
     * Returns argument value from the [arguments] for the argument at the index returned by
     * [decodeElementIndex]
     */
    override fun decodeValue(): Any {
        val arg = arguments[elementName]
        checkNotNull(arg) { "Unexpected null value for non-nullable argument $elementName" }
        return arg
    }

    override fun decodeNull(): Nothing? = null

    // we want to know if it is not null, so its !isNull
    override fun decodeNotNullMark(): Boolean = arguments[elementName] != null
}
```

```
package com.example.nav3recipes.deeplink.basic.util

import android.net.Uri

/**
 * Parse the requested Uri and store it in a easily readable format
 *
 * @param uri the target deeplink uri to link to
 */
internal class DeepLinkRequest(
    val uri: Uri
) {
    /**
     * A list of path segments
     */
    val pathSegments: List<String> = uri.pathSegments

    /**
     * A map of query name to query value
     */
    val queries = buildMap {
        uri.queryParameterNames.forEach { argName ->
            this[argName] = uri.getQueryParameter(argName)!!
        }
    }

    // TODO add parsing for other Uri components, i.e. fragments, mimeType, action
}
```

````
package com.example.nav3recipes.deeplink.basic.util

import android.net.Uri
import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.SerialKind
import kotlinx.serialization.encoding.CompositeDecoder
import java.io.Serializable

/**
 * Parse a supported deeplink and stores its metadata as a easily readable format
 *
 * The following notes applies specifically to this particular sample implementation:
 *
 * The supported deeplink is expected to be built from a serializable backstack key [T] that
 * supports deeplink. This means that if this deeplink contains any arguments (path or query),
 * the argument name must match any of [T] member field name.
 *
 * One [DeepLinkPattern] should be created for each supported deeplink. This means if [T]
 * supports two deeplink patterns:
 * ```
 *  val deeplink1 = www.nav3recipes.com/home
 *  val deeplink2 = www.nav3recipes.com/profile/{userId}
 *  ```
 * Then two [DeepLinkPattern] should be created
 * ```
 * val parsedDeeplink1 = DeepLinkPattern(T.serializer(), deeplink1)
 * val parsedDeeplink2 = DeepLinkPattern(T.serializer(), deeplink2)
 * ```
 *
 * This implementation assumes a few things:
 * 1. all path arguments are required/non-nullable - partial path matches will be considered a non-match
 * 2. all query arguments are optional by way of nullable/has default value
 *
 * @param T the backstack key type that supports the deeplinking of [uriPattern]
 * @param serializer the serializer of [T]
 * @param uriPattern the supported deeplink's uri pattern, i.e. "abc.com/home/{pathArg}"
 */
internal class DeepLinkPattern<T : NavKey>(
    val serializer: KSerializer<T>,
    val uriPattern: Uri
) {
    /**
     * Help differentiate if a path segment is an argument or a static value
     */
    private val regexPatternFillIn = Regex("\\{(.+?)\\}")

    // TODO make these lazy
    /**
     * parse the path into a list of [PathSegment]
     *
     * order matters here - path segments need to match in value and order when matching
     * requested deeplink to supported deeplink
     */
    val pathSegments: List<PathSegment> = buildList {
        uriPattern.pathSegments.forEach { segment ->
            // first, check if it is a path arg
            var result = regexPatternFillIn.find(segment)
            if (result != null) {
                // if so, extract the path arg name (the string value within the curly braces)
                val argName = result.groups[1]!!.value
                // from [T], read the primitive type of this argument to get the correct type parser
                val elementIndex = serializer.descriptor.getElementIndex(argName)
                if (elementIndex == CompositeDecoder.UNKNOWN_NAME) {
                    throw IllegalArgumentException(
                        "Path parameter '{$argName}' defined in the DeepLink $uriPattern does not exist in the Serializable class '${serializer.descriptor.serialName}'."
                    )
                }

                val elementDescriptor = serializer.descriptor.getElementDescriptor(elementIndex)
                // finally, add the arg name and its respective type parser to the map
                add(PathSegment(argName, true, getTypeParser(elementDescriptor.kind)))
            } else {
                // if its not a path arg, then its just a static string path segment
                add(PathSegment(segment, false, getTypeParser(PrimitiveKind.STRING)))
            }
        }
    }

    /**
     * Parse supported queries into a map of queryParameterNames to [TypeParser]
     *
     * This will be used later on to parse a provided query value into the correct KType
     */
    val queryValueParsers: Map<String, TypeParser> = buildMap {
        uriPattern.queryParameterNames.forEach { paramName ->
            val elementIndex = serializer.descriptor.getElementIndex(paramName)
            // Ignore static query parameters that are not in the Serializable class
            if (elementIndex != CompositeDecoder.UNKNOWN_NAME) {
                val elementDescriptor = serializer.descriptor.getElementDescriptor(elementIndex)
                this[paramName] = getTypeParser(elementDescriptor.kind)
            }
        }
    }

    /**
     * Metadata about a supported path segment
     */
    class PathSegment(
        val stringValue: String,
        val isParamArg: Boolean,
        val typeParser: TypeParser
    )
}

/**
 * Parses a String into a Serializable Primitive
 */
private typealias TypeParser = (String) -> Serializable

private fun getTypeParser(kind: SerialKind): TypeParser {
    return when (kind) {
        PrimitiveKind.STRING -> Any::toString
        PrimitiveKind.INT -> String::toInt
        PrimitiveKind.BOOLEAN -> String::toBoolean
        PrimitiveKind.BYTE -> String::toByte
        PrimitiveKind.CHAR -> String::toCharArray
        PrimitiveKind.DOUBLE -> String::toDouble
        PrimitiveKind.FLOAT -> String::toFloat
        PrimitiveKind.LONG -> String::toLong
        PrimitiveKind.SHORT -> String::toShort
        else -> throw IllegalArgumentException(
            "Unsupported argument type of SerialKind:$kind. The argument type must be a Primitive."
        )
    }
}
````

```
package com.example.nav3recipes.deeplink.basic.util

import android.util.Log
import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.KSerializer

internal class DeepLinkMatcher<T : NavKey>(
    val request: DeepLinkRequest,
    val deepLinkPattern: DeepLinkPattern<T>
) {
    /**
     * Match a [DeepLinkRequest] to a [DeepLinkPattern].
     *
     * Returns a [DeepLinkMatchResult] if this matches the pattern, returns null otherwise
     */
    fun match(): DeepLinkMatchResult<T>? {
        if (request.uri.scheme != deepLinkPattern.uriPattern.scheme) return null
        if (!request.uri.authority.equals(deepLinkPattern.uriPattern.authority, ignoreCase = true)) return null
        if (request.pathSegments.size != deepLinkPattern.pathSegments.size) return null
        // exact match (url does not contain any arguments)
        if (request.uri == deepLinkPattern.uriPattern)
            return DeepLinkMatchResult(deepLinkPattern.serializer, mapOf())

        val args = mutableMapOf<String, Any>()
        // match the path
        request.pathSegments
            .asSequence()
            // zip to compare the two objects side by side, order matters here so we
            // need to make sure the compared segments are at the same position within the url
            .zip(deepLinkPattern.pathSegments.asSequence())
            .forEach { it ->
                // retrieve the two path segments to compare
                val requestedSegment = it.first
                val candidateSegment = it.second
                // if the potential match expects a path arg for this segment, try to parse the
                // requested segment into the expected type
                if (candidateSegment.isParamArg) {
                    val parsedValue = try {
                        candidateSegment.typeParser.invoke(requestedSegment)
                    } catch (e: IllegalArgumentException) {
                        Log.e(TAG_LOG_ERROR, "Failed to parse path value:[$requestedSegment].", e)
                        return null
                    }
                    args[candidateSegment.stringValue] = parsedValue
                } else if(requestedSegment != candidateSegment.stringValue){
                    // if it's path arg is not the expected type, its not a match
                    return null
                }
            }
        // match queries (if any)
        request.queries.forEach { query ->
            val name = query.key
            // If the pattern does not define this query parameter, ignore it.
            // This prevents a NullPointerException.
            val queryStringParser = deepLinkPattern.queryValueParsers[name]?: return@forEach
            
            val queryParsedValue = try {
                queryStringParser.invoke(query.value)
            } catch (e: IllegalArgumentException) {
                Log.e(TAG_LOG_ERROR, "Failed to parse query name:[$name] value:[${query.value}].", e)
                return null
            }
            args[name] = queryParsedValue
        }
        // provide the serializer of the matching key and map of arg names to parsed arg values
        return DeepLinkMatchResult(deepLinkPattern.serializer, args)
    }
}


/**
 * Created when a requested deeplink matches with a supported deeplink
 *
 * @param [T] the backstack key associated with the deeplink that matched with the requested deeplink
 * @param serializer serializer for [T]
 * @param args The map of argument name to argument value. The value is expected to have already
 * been parsed from the raw url string back into its proper KType as declared in [T].
 * Includes arguments for all parts of the uri - path, query, etc.
 * */
internal data class DeepLinkMatchResult<T : NavKey>(
    val serializer: KSerializer<T>,
    val args: Map<String, Any>
)

const val TAG_LOG_ERROR = "Nav3RecipesDeepLink"
```

```
package com.example.nav3recipes.deeplink.basic.ui

import com.example.nav3recipes.deeplink.basic.SearchKey

/**
 * String resources
 */
internal const val STRING_LITERAL_FILTER = "filter"
internal const val STRING_LITERAL_HOME = "home"
internal const val STRING_LITERAL_USERS = "users"
internal const val STRING_LITERAL_SEARCH = "search"
internal const val STRING_LITERAL_INCLUDE = "include"
internal const val PATH_BASE = "https://www.nav3recipes.com"
internal const val PATH_INCLUDE = "$STRING_LITERAL_USERS/$STRING_LITERAL_INCLUDE"
internal const val PATH_SEARCH = "$STRING_LITERAL_USERS/$STRING_LITERAL_SEARCH"
internal const val URL_HOME_EXACT = "$PATH_BASE/$STRING_LITERAL_HOME"

internal const val URL_USERS_WITH_FILTER = "$PATH_BASE/$PATH_INCLUDE/{$STRING_LITERAL_FILTER}"
internal val URL_SEARCH = "$PATH_BASE/$PATH_SEARCH" +
        "?${SearchKey::ageMin.name}={${SearchKey::ageMin.name}}" +
        "&${SearchKey::ageMax.name}={${SearchKey::ageMax.name}}" +
        "&${SearchKey::firstName.name}={${SearchKey::firstName.name}}" +
        "&${SearchKey::location.name}={${SearchKey::location.name}}"
```