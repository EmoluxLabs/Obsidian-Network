package network.obsidian.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The Obsidian design system, transcribed from `obsidian-app.html`.
 *
 * The single source of truth is that file's one `<style>` block. Every value
 * below carries the selector it came from, so a reviewer can check any number
 * against the HTML rather than trusting this file. There is no second design
 * source: where an earlier version of this file quoted an artboard ZIP, those
 * values were replaced by the stylesheet's own.
 *
 * Typeface note: the stylesheet sets `body{font-family:system-ui,-apple-system,
 * "Segoe UI",Roboto,sans-serif}` and `.m{font-family:ui-monospace,Menlo,
 * Consolas,monospace}`. It does not name Manrope or JetBrains Mono anywhere, so
 * neither is bundled here — the system sans and mono stacks are the design.
 */
object ObsidianColors {
    /** `:root{--bg:#F6F7F9}` — page canvas, painted by `#app`. */
    val Canvas = Color(0xFFF6F7F9)

    /** `.card{background:#fff}` — white surfaces on the grey canvas. */
    val Surface = Color(0xFFFFFFFF)

    /** `:root{--ob:#0B0D10}` — headings and the primary button fill. */
    val Ink = Color(0xFF0B0D10)

    /** `:root{--tx:#111318}` — body text. */
    val Text = Color(0xFF111318)

    /** `:root{--mu:#68707C}` — `.mu`, `label`, `.row span`. */
    val Muted = Color(0xFF68707C)

    /** `:root{--bd:#E4E7EB}` — card borders, header rule, splash ring track. */
    val Border = Color(0xFFE4E7EB)

    /** `.row{border-top:1px solid #EEF0F3}` — separators inside cards. */
    val Divider = Color(0xFFEEF0F3)

    /** `.btn{border:1.5px solid #D5D9DF}` — the secondary button outline, and
     *  the node toggle's off-state track. */
    val BorderStrong = Color(0xFFD5D9DF)

    /** `:root{--go:#C8A85A}` — the only accent. Focus rings, progress arcs, the
     *  toggle knob, the sign-in link underline. */
    val Gold = Color(0xFFC8A85A)

    /** `:root{--gd:#7A6126}` — `.lb` section labels, the splash tagline, and the
     *  wallet name pill's text. Gold as text, because #C8A85A on white fails. */
    val GoldText = Color(0xFF7A6126)

    /** The wallet name pill: `style="background:#FBF6E8;color:var(--gd)"`.
     *  No border — the stylesheet gives this pill none. */
    val GoldPillFill = Color(0xFFFBF6E8)

    /** `.pill{background:#EAF6F0;color:var(--ok)}` — status pills, borderless. */
    val SuccessPillFill = Color(0xFFEAF6F0)

    /** `:root{--ok:#1F7A55}`. The stylesheet defines exactly one green; there is
     *  no second "dot" green, and none is invented here. */
    val Success = Color(0xFF1F7A55)

    /** `:root{--er:#A12626}` — `.err` text and the SIGN OUT label. */
    val Danger = Color(0xFFA12626)

    /** The SIGN OUT button's outline: `border-color:#E7C9C9`. The stylesheet has
     *  no error *fill*; failures are coloured text on white. */
    val DangerBorder = Color(0xFFE7C9C9)

    /** `#E3C877` — accent on dark surfaces: the landing footer tagline and the
     *  API code block. */
    val GoldLight = Color(0xFFE3C877)

    /** `.btn.p{box-shadow:0 10px 22px rgba(11,13,16,.22)}` and the landing
     *  medallion's `rgba(11,13,16,.08)` — one shadow tint, two opacities. */
    val Shadow = Color(0xFF0B0D10)
}

/**
 * Corner radii. The stylesheet defines seven distinct ones plus the pill, and
 * they are not interchangeable: a card is 20, a quick-link tile is 18, an input
 * is 14. Collapsing them was the single most visible way the app drifted.
 */
object ObsidianRadius {
    /** `.card{border-radius:20px}` */
    val Card = 20.dp

    /** `.big{border-radius:18px}` — the HOME and MENU quick-link tiles. */
    val Big = 18.dp

    /** The API `<pre>` block: `border-radius:18px`. */
    val Code = 18.dp

    /** `input{border-radius:14px}`, and the landing menu button. */
    val Input = 14.dp

    /** `.btn{border-radius:16px}` */
    val Button = 16.dp

    /** The node toggle: `border-radius:15px`. */
    val Toggle = 15.dp

    /** The landing footer card: `border-radius:24px`. */
    val Footer = 24.dp

    /** `.pill{border-radius:99px}` */
    val Pill = 999.dp
}

/**
 * Spacing. The stylesheet has no scale object — these are the literal margins
 * and paddings it repeats, kept named so screens stop restating them.
 */
object ObsidianSpace {
    /** `.err{margin-top:10px}`, `.big` copy `margin-top:4px` sits at half this. */
    val XXS = 4.dp
    /** `label{margin:16px 0 8px 2px}` — the gap under a form label. */
    val XS = 8.dp
    /** `.btn{margin-top:12px}` */
    val S = 12.dp
    /** `.card{padding:6px 16px}` — horizontal card padding, and the page gutter. */
    val M = 16.dp
    /** `.card[style*="padding:20px"]` — balance and status cards. */
    val L = 20.dp
    /** The landing medallion's `margin:24px auto`. */
    val XL = 24.dp
    /** `input{padding:0 16px}` */
    val FieldPaddingH = 16.dp

    /** `#app{padding:0 20px 100px}` — horizontal gutter. */
    val Gutter = 20.dp

    /** `#app{padding:0 20px 100px}` — the clearance kept for the fixed `.nav`.
     *  A screen that scrolls under the tab bar has broken this. */
    val NavClearance = 100.dp

    /** `#app{max-width:430px}` — the design width every measurement assumes. */
    val PageMaxWidth = 430.dp
}

/** Component metrics that are part of the design, not implementation detail. */
object ObsidianMetrics {
    /** `.hd{height:68px}` */
    val HeaderHeight = 68.dp

    /** `.btn{height:56px}` — both the primary and the secondary button. */
    val PrimaryButtonHeight = 56.dp
    val SecondaryButtonHeight = 56.dp

    /** The landing header logo: `logo(38)`. Other sizes are per-screen and are
     *  passed explicitly there, because the HTML varies them: 34 in `hdr()`, 76
     *  on sign-up, 96 on sign-in, 150 in the splash, 190 in the landing medallion. */
    val LogoSize = 38.dp

    /** The landing menu button: `width:48px;height:48px`. */
    val MenuButtonSize = 48.dp

    /** `input{height:56px}` */
    val InputHeight = 56.dp

    /** `.row{padding:13px 0}` */
    val RowPaddingV = 13.dp

    /** `.card{padding:6px 16px}` */
    val CardPaddingV = 6.dp
    val CardPaddingH = 16.dp

    /** `.nav{height:72px}` */
    val NavHeight = 72.dp

    /** `.nav a{padding:10px 8px}` */
    val NavItemPaddingV = 10.dp
    val NavItemPaddingH = 8.dp

    /** `.nav a.on::before{width:18px;height:3px;border-radius:2px;margin:0 auto 6px}` */
    val NavIndicatorWidth = 18.dp
    val NavIndicatorHeight = 3.dp
    val NavIndicatorGap = 6.dp

    /** The node toggle: `width:52px;height:30px` with a 24px knob inset 3px. */
    val ToggleWidth = 52.dp
    val ToggleHeight = 30.dp
    val ToggleKnob = 24.dp
    val ToggleInset = 3.dp

    /** The landing drawer rows: `height:54px`. */
    val MenuRowHeight = 54.dp

    /** `.hd` keeps a 10px gap between the logo and the wordmark. */
    val HeaderGap = 10.dp

    /** `StatusDot` is not in the stylesheet — the HTML marks status with `.pill`
     *  text. Kept for the connection indicator, sized to match `.pill` height. */
    val StatusDot = 9.dp

    /** The splash ring (`240px`, `r=112`, `stroke-width=5`) and the mine ring
     *  (`250px`, `r=108`, `stroke-width=6`). */
    val SplashRing = 240.dp
    val SplashRingRadius = 112.dp
    val SplashRingStroke = 5.dp
    val MineRing = 250.dp
    val MineRingRadius = 108.dp
    val MineRingStroke = 6.dp

    /** The landing medallion: `width:260px;height:260px;border-radius:50%`. */
    val LandingMedallion = 260.dp
}

/**
 * The type scale. Each style cites the rule it comes from; the HTML's default
 * body size is the browser's 16px, which is why `Body` is 16 and not smaller.
 */
object ObsidianType {
    /** `body{font-family:system-ui,…}` and `.m{font-family:ui-monospace,…}`. */
    val FontSans = FontFamily.SansSerif
    val FontMono = FontFamily.Monospace

    /** `h1{font-size:30px;line-height:1.1;letter-spacing:-.02em;font-weight:800}` */
    val Hero = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 30.sp,
        lineHeight = 33.sp, letterSpacing = (-0.6).sp,
    )

    /** `<h1 style="font-size:26px">` — ONS, NODE, API and sign-up headings. */
    val HeadingLarge = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 26.sp,
        lineHeight = 28.6.sp, letterSpacing = (-0.52).sp,
    )

    /** `<h1 style="font-size:24px">Welcome back.</h1>` on HOME. */
    val HeadingSmall = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp,
        lineHeight = 26.4.sp, letterSpacing = (-0.48).sp,
    )

    /** The balance figure: `font-size:34px;font-weight:600` in `.m`. */
    val Balance = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.SemiBold, fontSize = 34.sp,
    )

    /** `.btn{font-weight:800;font-size:15px;letter-spacing:.12em}` */
    val Button = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp,
        letterSpacing = 1.8.sp,
    )

    /** `.big{font-weight:800;letter-spacing:.12em}` — MINING / WALLET / ONS tiles,
     *  and the 15px card titles. */
    val CardTitle = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp,
        letterSpacing = 1.8.sp,
    )

    /** Body copy. The stylesheet sets no `font-size` on `p`, so this inherits the
     *  16px default; `line-height:1.55` comes from the landing paragraph. */
    val Body = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Normal, fontSize = 16.sp,
        lineHeight = 25.sp,
    )

    /** `.row{font-size:14px}` — a row's value, bolded by the enclosing `<b>`. */
    val Value = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Bold, fontSize = 14.sp,
    )

    /** The 12.5px captions on WALLET, NODE and the `.big` tile subtitles
     *  (`font-size:14px;margin-top:4px` uses [Value] instead). */
    val Support = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Normal, fontSize = 12.5.sp,
        lineHeight = 18.sp,
    )

    /** `font-size:12px` — timestamps under transactions, hashes under blocks,
     *  the address on MENU. */
    val Caption = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Normal, fontSize = 12.sp,
        lineHeight = 17.sp,
    )

    /** `label{font-size:11px;font-weight:800;letter-spacing:.16em;color:var(--mu)}` */
    val Label = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 11.sp,
        letterSpacing = 1.76.sp,
    )

    /** `.lb{font-size:11px;font-weight:800;letter-spacing:.18em;color:var(--gd)}` */
    val Kicker = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 11.sp,
        letterSpacing = 1.98.sp,
    )

    /** `.row span{font-size:11px;font-weight:800;letter-spacing:.14em}` */
    val RowKey = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 11.sp,
        letterSpacing = 1.54.sp,
    )

    /** `.pill{font-size:10px;font-weight:800;letter-spacing:.1em}` */
    val Pill = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 10.sp,
        letterSpacing = 1.0.sp,
    )

    /** `.err{font-size:13px;font-weight:600}` */
    val Error = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
    )

    /** `input{font-size:16px}` */
    val Input = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Normal, fontSize = 16.sp,
    )

    /** The wordmark beside the header logo: `font-size:13px;letter-spacing:.18em`
     *  inside a `<b>`. */
    val Wordmark = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp,
        letterSpacing = 2.34.sp,
    )

    /** Sign-up and sign-in: `font-size:13px;letter-spacing:.22em`. */
    val WordmarkAuth = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp,
        letterSpacing = 2.86.sp,
    )

    /** The splash wordmark is a bare `<b>` at the 16px default, `.24em`. */
    val WordmarkSplash = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp,
        letterSpacing = 3.84.sp,
    )

    /** The splash tagline: `font-size:10.5px;font-weight:700;letter-spacing:.2em`. */
    val WordmarkSub = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.Bold, fontSize = 10.5.sp,
        letterSpacing = 2.1.sp,
    )

    /** The landing footer: `font-size:13px;letter-spacing:.2em` in a `<b>`. */
    val Statement = TextStyle(
        fontFamily = FontSans, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp,
        letterSpacing = 2.6.sp,
    )

    /** `.m` at the sizes the HTML uses: 11px for inline hashes and pills. */
    val Mono = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.SemiBold, fontSize = 11.sp,
        letterSpacing = 0.44.sp,
    )

    /** `.row b.m` — block heights, rates, amounts: inherits the row's 14px. */
    val MonoValue = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
    )

    /** The mine countdown: `font-size:26px;font-weight:600` in `.m`. */
    val MonoLarge = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.SemiBold, fontSize = 26.sp,
    )

    /** The ONS result card: `font-size:17px` in `.m`. */
    val MonoTitle = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.SemiBold, fontSize = 17.sp,
    )

    /** The API block: `font-size:12.5px;line-height:1.6` in `.m`. */
    val Code = TextStyle(
        fontFamily = FontMono, fontWeight = FontWeight.Normal, fontSize = 12.5.sp,
        lineHeight = 20.sp,
    )
}
