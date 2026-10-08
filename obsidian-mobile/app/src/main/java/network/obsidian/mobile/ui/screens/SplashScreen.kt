package network.obsidian.mobile.ui.screens

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import network.obsidian.mobile.R
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianType

/**
 * The `splash` entry of the blueprint's `const V`, reproduced element by element:
 * a 240px ring on a #E4E7EB track with a gold #C8A85A arc, the 150px mark centred
 * inside it, the OBSIDIAN NETWORK wordmark 34px below, and "THE PROOF OF TIME
 * BLOCKCHAIN" 8px below that in the dark gold.
 *
 * It holds for exactly the blueprint's 2000ms — `setTimeout(() => go(…), 2000)` —
 * and then routes to the landing page, or to the wallet if a profile already
 * exists on this device. That is a brand beat, not a progress indicator: nothing
 * here represents connecting to a node, and no chain data is read while it shows.
 *
 * It leaves on a fixed delay and never waits on the network. Gating the splash on
 * a node answering would leave a user with no chain connection staring at a logo
 * with no way out — and the whole point of the offline states elsewhere in the app
 * is that being unable to reach a node is a condition the UI describes, not one it
 * hangs on.
 */
@Composable
fun SplashScreen(onFinished: () -> Unit) {
    // animation: sp 2.4s linear infinite — one full turn every 2.4 seconds.
    val transition = rememberInfiniteTransition(label = "splash")
    val sweep by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(2400, easing = LinearEasing), RepeatMode.Restart),
        label = "ring",
    )
    // animation: fd .8s .6s both — the wordmark fades up after 0.6s.
    //
    // An Animatable rather than the infinite transition above: this one runs once
    // and holds, and animateFloat on an InfiniteTransition only accepts a
    // repeating spec.
    val fade = remember { Animatable(0f) }
    val fadeTagline = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        delay(600)
        fade.animateTo(1f, tween(800))
    }
    LaunchedEffect(Unit) {
        delay(800)
        fadeTagline.animateTo(1f, tween(800))
    }

    LaunchedEffect(Unit) {
        delay(SPLASH_MILLIS)
        onFinished()
    }

    // The ring is drawn rather than pasted in as a bitmap so the 2.4s rotation
    // stays smooth at any density, and so the arc length stays a real ratio: 150
    // of the 704-unit circumference the SVG's stroke-dasharray="150 554" implies.
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ObsidianColors.Canvas),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.size(240.dp)) {
                Canvas(Modifier.size(224.dp).rotate(sweep)) {
                    val stroke = 5.dp.toPx()
                    val inset = stroke / 2
                    val arc = Size(size.width - stroke, size.height - stroke)
                    val topLeft = Offset(inset, inset)
                    // Track, then the gold arc: 150/704 of the circumference,
                    // matching stroke-dasharray="150 554" in the reference.
                    drawArc(
                        color = ObsidianColors.Border,
                        startAngle = 0f, sweepAngle = 360f, useCenter = false,
                        topLeft = topLeft, size = arc, style = Stroke(width = stroke),
                    )
                    drawArc(
                        color = ObsidianColors.Gold,
                        startAngle = -90f, sweepAngle = 360f * 150f / 704f, useCenter = false,
                        topLeft = topLeft, size = arc,
                        style = Stroke(width = stroke, cap = StrokeCap.Round),
                    )
                }
                Image(
                    painter = painterResource(R.drawable.obsidian_logo),
                    contentDescription = "Obsidian",
                    modifier = Modifier.size(150.dp).alpha(fade.value),
                    contentScale = ContentScale.Fit,
                )
            }
            Spacer(Modifier.height(34.dp))
            Text(
                "OBSIDIAN NETWORK",
                style = ObsidianType.WordmarkSplash,
                color = ObsidianColors.Ink,
                modifier = Modifier.alpha(fade.value),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "THE PROOF OF TIME BLOCKCHAIN",
                style = ObsidianType.WordmarkSub,
                color = ObsidianColors.GoldText,
                modifier = Modifier.alpha(fadeTagline.value),
            )
        }
    }
}

/** The blueprint's own dwell: `setTimeout(() => { if (cur === 'splash') go(…) }, 2000)`. */
private const val SPLASH_MILLIS = 2_000L
