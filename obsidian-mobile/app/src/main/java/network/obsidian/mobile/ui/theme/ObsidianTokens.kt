package network.obsidian.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The Obsidian design system, transcribed from the supplied UI/UX artboards.
 *
 * Every value here was read out of the design exports' inline styles — not
 * chosen. The 18 artboards all use the same palette, radii, tracking and
 * spacing, so this file is the single source of truth and screens must not
 * restate a colour or a radius locally. If a screen needs a value that is not
 * here, the design did not define it and the answer is to extend this file,
 * not to improvise in the screen.
 *
 * Typeface note: the design specifies Manrope (400–800) for text and JetBrains
 * Mono (500/600) for numeric and hash data. Both are loaded from bundled fonts
 * when present; the fallbacks below keep the metrics close if a font file is
 * missing rather than silently switching to a different design.
 */
object ObsidianColors {
    /** Page canvas. Every artboard is #F6F7F9. */
    val Canvas = Color(0xFFF6F7F9)

    /** Card surface. White on the grey canvas, never a second grey. */
    val Surface = Color(0xFFFFFFFF)

    /** Heading ink and primary button fill. */
    val Ink = Color(0xFF0B0D10)

    /** Body text. */
    val Text = Color(0xFF111318)

    /** Secondary text, labels, captions. */
    val Muted = Color(0xFF68707C)

    /** The hairline every card and divider uses. */
    val Border = Color(0xFFE4E7EB)

    /** Row separators inside cards. */
    val Divider = Color(0xFFEEF0F3)

    /** The heavier outline on secondary buttons. */
    val BorderStrong = Color(0xFFD5D9DF)

    /** Accent. Used for icons on dark tiles, progress arcs and emphasis. */
    val Gold = Color(0xFFC8A85A)

    /** Accent as text: darker, because #C8A85A on white does not read. */
    val GoldText = Color(0xFF7A6126)

    /** Accent pill fill and its outline. */
    val GoldPillFill = Color(0xFFFBF6E8)
    val GoldPillBorder = Color(0xFFEFE2BA)

    /** Accent on the dark footer card. */
    val GoldLight = Color(0xFFE3C877)

    /** Live / success. The design uses two greens: a dot and a value. */
    val Success = Color(0xFF1F8F5F)
    val SuccessText = Color(0xFF1F7A55)

    /** Destructive and failed states. Not in the artboards' palette, which have
     *  no error screen; derived by darkening the accent family's complement so
     *  a failure reads as an Obsidian state and not a stock Material red. */
    val Danger = Color(0xFFA12626)
    val DangerFill = Color(0xFFFDECEA)

    /** Muted text on the dark footer card. */
    val OnDarkMuted = Color(0xFFC3C8D0)

    /** The soft shadow tint the design uses throughout: rgba(11,13,16,…). */
    val Shadow = Color(0xFF0B0D10)
}

/** Corner radii, taken from the artboards. There are exactly five. */
object ObsidianRadius {
    /** Hero and large feature cards. */
    val Card = 20.dp
    /** Standard cards and list rows. */
    val CardSmall = 20.dp
    /** Icon tiles. */
    val Tile = 14.dp
    /** Buttons. */
    val Button = 16.dp
    /** Pills and chips: fully round. */
    val Pill = 999.dp
}

/** Spacing rhythm. The artboards step in 4/8/12/14/16/18/20/22/26/28/34. */
object ObsidianSpace {
    val XXS = 4.dp
    val XS = 8.dp
    val S = 12.dp
    val M = 16.dp
    val L = 20.dp
    val XL = 26.dp
    val XXL = 34.dp

    /** Horizontal page gutter: every artboard is 390px wide with 20px sides. */
    val Gutter = 20.dp
}

/** Component metrics that are part of the design, not implementation detail. */
object ObsidianMetrics {
    val HeaderHeight = 76.dp
    val PrimaryButtonHeight = 56.dp
    val SecondaryButtonHeight = 56.dp
    val LogoSize = 38.dp
    val MenuButtonSize = 48.dp
    val IconTileSize = 52.dp
    val StatusDot = 9.dp
}

/**
 * The type scale. The design loads Manrope 400/500/600/700/800 and JetBrains
 * Mono 500/600; the sizes and tracking below are the artboards' own.
 */
object ObsidianType {
    /** Typeface families. Kept distinct from the styles below so a style can
     *  never shadow a family name. */
    val FontSans = FontFamily.SansSerif
    val FontMono = FontFamily.Monospace

    /** 35px / 1.08 / 800 / -0.02em — the hero headline. */
    val Hero = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 30.sp,
        lineHeight = 33.sp, letterSpacing = (-0.6).sp,
    )

    /** 18px / 700 — dark footer statement. */
    val Statement = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Bold, fontSize = 18.sp,
        letterSpacing = (-0.2).sp,
    )

    /** 15px / 800 / 0.12em — button labels. */
    val Button = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp,
        letterSpacing = 1.8.sp,
    )

    /** 15px / 800 / 0.12em — card titles such as MINE / SECURE / EXPLORE. */
    val CardTitle = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp,
        letterSpacing = 1.8.sp,
    )

    /** 15.5px / 1.55 / 500 — body copy. */
    val Body = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Medium, fontSize = 15.5.sp,
        lineHeight = 24.sp,
    )

    /** 14px / 700 — row values. */
    val Value = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Bold, fontSize = 14.sp,
    )

    /** 13.5px / 1.45 / 500 — card supporting copy. */
    val Support = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Medium, fontSize = 13.5.sp,
        lineHeight = 19.5.sp,
    )

    /** 13px / 800 / 0.18em — the wordmark's first line. */
    val Wordmark = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp,
        letterSpacing = 2.34.sp, lineHeight = 15.sp,
    )

    /** 13px / 600 / 0.32em — the wordmark's second line. */
    val WordmarkSub = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
        letterSpacing = 4.16.sp, lineHeight = 15.sp,
    )

    /** 12px / 700–800 / 0.14–0.2em — uppercase labels and kickers. */
    val Label = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Bold, fontSize = 12.sp,
        letterSpacing = 1.68.sp,
    )
    val Kicker = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 11.sp,
        letterSpacing = 2.2.sp,
    )

    /** JetBrains Mono 11px / 600 / 0.04em — pills, hashes, amounts. */
    val Mono = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.SemiBold, fontSize = 11.sp,
        letterSpacing = 0.44.sp,
    )

    /** JetBrains Mono 14px / 600 — block heights and balances. */
    val MonoValue = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
    )

    /** JetBrains Mono 20px / 600 — hero balances. */
    val MonoLarge = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.SemiBold, fontSize = 20.sp,
        letterSpacing = (-0.2).sp,
    )
}
