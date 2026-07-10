When creating a `Typography` instance with the Google Sans Flex configuration,
refer to the following source code in `GoogleSansFlexTypography.kt`:


```kotlin
/*
 * Copyright 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

@file:Suppress("MentionsGoogle")

package androidx.xr.glimmer.googlefonts

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.Font
import androidx.compose.ui.text.googlefonts.GoogleFont
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp
import androidx.xr.glimmer.Typography

/**
 * Returns a [Typography] instance configured with Google Sans Flex and customized with the
 * recommended settings for Jetpack Compose Glimmer.
 *
 * Note: Google Sans Flex is a variable font. It is recommended to configure attributes such as
 * weight, slant, and grade by using [FontVariation.Settings] (e.g. [FontVariation.weight]) rather
 * than the [TextStyle] properties.
 *
 * @sample androidx.xr.glimmer.googlefonts.samples.GoogleSansFlexTypographySample
 * @param titleLarge the [TextStyle] for [Typography.titleLarge]
 * @param titleLargeVariationSettings the [FontVariation.Settings] for [Typography.titleLarge].
 * @param titleMedium the [TextStyle] for [Typography.titleMedium].
 * @param titleMediumVariationSettings the [FontVariation.Settings] for [Typography.titleMedium].
 * @param titleSmall the [TextStyle] for [Typography.titleSmall].
 * @param titleSmallVariationSettings the [FontVariation.Settings] for [Typography.titleSmall].
 * @param bodyLarge the [TextStyle] for [Typography.bodyLarge].
 * @param bodyLargeVariationSettings the [FontVariation.Settings] for [Typography.bodyLarge].
 * @param bodyMedium the [TextStyle] for [Typography.bodyMedium].
 * @param bodyMediumVariationSettings the [FontVariation.Settings] for [Typography.bodyMedium].
 * @param bodySmall the [TextStyle] for [Typography.bodySmall].
 * @param bodySmallVariationSettings the [FontVariation.Settings] for [Typography.bodySmall].
 * @param caption the [TextStyle] for [Typography.caption].
 * @param captionVariationSettings the [FontVariation.Settings] for [Typography.caption].
 */
@Suppress("MentionsGoogle")
public fun createGoogleSansFlexTypography(
    titleLarge: TextStyle = GoogleSansFlexTypographyDefaults.TitleLarge,
    titleLargeVariationSettings: FontVariation.Settings =
        GoogleSansFlexTypographyDefaults.TitleLargeVariationSettings,
    titleMedium: TextStyle = GoogleSansFlexTypographyDefaults.TitleMedium,
    titleMediumVariationSettings: FontVariation.Settings =
        GoogleSansFlexTypographyDefaults.TitleMediumVariationSettings,
    titleSmall: TextStyle = GoogleSansFlexTypographyDefaults.TitleSmall,
    titleSmallVariationSettings: FontVariation.Settings =
        GoogleSansFlexTypographyDefaults.TitleSmallVariationSettings,
    bodyLarge: TextStyle = GoogleSansFlexTypographyDefaults.BodyLarge,
    bodyLargeVariationSettings: FontVariation.Settings =
        GoogleSansFlexTypographyDefaults.BodyLargeVariationSettings,
    bodyMedium: TextStyle = GoogleSansFlexTypographyDefaults.BodyMedium,
    bodyMediumVariationSettings: FontVariation.Settings =
        GoogleSansFlexTypographyDefaults.BodyMediumVariationSettings,
    bodySmall: TextStyle = GoogleSansFlexTypographyDefaults.BodySmall,
    bodySmallVariationSettings: FontVariation.Settings =
        GoogleSansFlexTypographyDefaults.BodySmallVariationSettings,
    caption: TextStyle = GoogleSansFlexTypographyDefaults.Caption,
    captionVariationSettings: FontVariation.Settings =
        GoogleSansFlexTypographyDefaults.CaptionVariationSettings,
): Typography {
    val titleLargeFontFamily = FontFamily(GoogleSansFlexFont, titleLargeVariationSettings)
    val titleMediumFontFamily = FontFamily(GoogleSansFlexFont, titleMediumVariationSettings)
    val titleSmallFontFamily = FontFamily(GoogleSansFlexFont, titleSmallVariationSettings)
    val bodyLargeFontFamily = FontFamily(GoogleSansFlexFont, bodyLargeVariationSettings)
    val bodyMediumFontFamily = FontFamily(GoogleSansFlexFont, bodyMediumVariationSettings)
    val bodySmallFontFamily = FontFamily(GoogleSansFlexFont, bodySmallVariationSettings)
    val captionFontFamily = FontFamily(GoogleSansFlexFont, captionVariationSettings)

    return Typography(
        titleLarge = titleLarge.copy(fontFamily = titleLargeFontFamily),
        titleMedium = titleMedium.copy(fontFamily = titleMediumFontFamily),
        titleSmall = titleSmall.copy(fontFamily = titleSmallFontFamily),
        bodyLarge = bodyLarge.copy(fontFamily = bodyLargeFontFamily),
        bodyMedium = bodyMedium.copy(fontFamily = bodyMediumFontFamily),
        bodySmall = bodySmall.copy(fontFamily = bodySmallFontFamily),
        caption = caption.copy(fontFamily = captionFontFamily),
    )
}

/** Default variable font configurations for using Google Sans Flex in Jetpack Compose Glimmer */
@Suppress("MentionsGoogle")
public object GoogleSansFlexTypographyDefaults {
    private val RoundVariationSetting = FontVariation.Setting("ROND", 100.0f)

    /** Default [TextStyle] for [Typography.titleLarge]. */
    public val TitleLarge: TextStyle =
        TextStyle(
            fontWeight = FontWeight.Normal,
            fontSize = 30.sp,
            lineHeight = 36.sp,
            letterSpacing = DefaultLetterSpacing,
            lineHeightStyle = DefaultLineHeightStyle,
        )

    /** Default [FontVariation.Settings] for [Typography.titleLarge]. */
    public val TitleLargeVariationSettings: FontVariation.Settings =
        FontVariation.Settings(
            FontVariation.grade(0),
            FontVariation.weight(750),
            FontVariation.slant(0f),
            FontVariation.width(100f),
            FontVariation.opticalSizing(9.sp),
            RoundVariationSetting,
        )

    /** Default [TextStyle] for [Typography.titleMedium]. */
    public val TitleMedium: TextStyle =
        TextStyle(
            fontWeight = FontWeight.Normal,
            fontSize = 24.sp,
            lineHeight = 28.sp,
            letterSpacing = DefaultLetterSpacing,
            lineHeightStyle = DefaultLineHeightStyle,
        )

    /** Default [FontVariation.Settings] for [Typography.titleMedium]. */
    public val TitleMediumVariationSettings: FontVariation.Settings =
        FontVariation.Settings(
            FontVariation.grade(0),
            FontVariation.weight(750),
            FontVariation.slant(0f),
            FontVariation.width(100f),
            FontVariation.opticalSizing(9.sp),
            RoundVariationSetting,
        )

    /** Default [TextStyle] for [Typography.titleSmall]. */
    public val TitleSmall: TextStyle =
        TextStyle(
            fontWeight = FontWeight.Normal,
            fontSize = 20.sp,
            lineHeight = 28.sp,
            letterSpacing = DefaultLetterSpacing,
            lineHeightStyle = DefaultLineHeightStyle,
        )

    /** Default [FontVariation.Settings] for [Typography.titleSmall]. */
    public val TitleSmallVariationSettings: FontVariation.Settings =
        FontVariation.Settings(
            FontVariation.grade(0),
            FontVariation.weight(750),
            FontVariation.slant(0f),
            FontVariation.width(100f),
            FontVariation.opticalSizing(9.sp),
            RoundVariationSetting,
        )

    /** Default [TextStyle] for [Typography.bodyLarge]. */
    public val BodyLarge: TextStyle =
        TextStyle(
            fontWeight = FontWeight.Normal,
            fontSize = 30.sp,
            lineHeight = 36.sp,
            letterSpacing = DefaultLetterSpacing,
            lineHeightStyle = DefaultLineHeightStyle,
        )

    /** Default [FontVariation.Settings] for [Typography.bodyLarge]. */
    public val BodyLargeVariationSettings: FontVariation.Settings =
        FontVariation.Settings(
            FontVariation.grade(0),
            FontVariation.weight(520),
            FontVariation.slant(0f),
            FontVariation.width(100f),
            FontVariation.opticalSizing(9.sp),
            RoundVariationSetting,
        )

    /** Default [TextStyle] for [Typography.bodyMedium]. */
    public val BodyMedium: TextStyle =
        TextStyle(
            fontWeight = FontWeight.Normal,
            fontSize = 24.sp,
            lineHeight = 36.sp,
            letterSpacing = DefaultLetterSpacing,
            lineHeightStyle = DefaultLineHeightStyle,
        )

    /** Default [FontVariation.Settings] for [Typography.bodyMedium]. */
    public val BodyMediumVariationSettings: FontVariation.Settings =
        FontVariation.Settings(
            FontVariation.grade(0),
            FontVariation.weight(520),
            FontVariation.slant(0f),
            FontVariation.width(100f),
            FontVariation.opticalSizing(9.sp),
            RoundVariationSetting,
        )

    /** Default [TextStyle] for [Typography.bodySmall]. */
    public val BodySmall: TextStyle =
        TextStyle(
            fontWeight = FontWeight.Normal,
            fontSize = 20.sp,
            lineHeight = 28.sp,
            letterSpacing = DefaultLetterSpacing,
            lineHeightStyle = DefaultLineHeightStyle,
        )

    /** Default [FontVariation.Settings] for [Typography.bodySmall]. */
    public val BodySmallVariationSettings: FontVariation.Settings =
        FontVariation.Settings(
            FontVariation.grade(0),
            FontVariation.weight(520),
            FontVariation.slant(0f),
            FontVariation.width(100f),
            FontVariation.opticalSizing(9.sp),
            RoundVariationSetting,
        )

    /** Default [TextStyle] for [Typography.caption]. */
    public val Caption: TextStyle =
        TextStyle(
            fontWeight = FontWeight.Normal,
            fontSize = 18.sp,
            lineHeight = 24.sp,
            letterSpacing = DefaultLetterSpacing,
            lineHeightStyle = DefaultLineHeightStyle,
        )

    /** Default [FontVariation.Settings] for [Typography.caption]. */
    public val CaptionVariationSettings: FontVariation.Settings =
        FontVariation.Settings(
            FontVariation.grade(0),
            FontVariation.weight(650),
            FontVariation.slant(0f),
            FontVariation.width(100f),
            FontVariation.opticalSizing(9.sp),
            RoundVariationSetting,
        )
}

private val GoogleSansFlexFont = GoogleFont("Google Sans Flex")

private val DefaultLetterSpacing = 0.sp

private val DefaultLineHeightStyle: LineHeightStyle =
    LineHeightStyle(
        alignment = LineHeightStyle.Alignment.Proportional,
        trim = LineHeightStyle.Trim.FirstLineTop,
    )

private fun FontFamily(font: GoogleFont, variationSettings: FontVariation.Settings): FontFamily =
    FontFamily(Font(googleFont = font, variationSettings = variationSettings))
```

<br />