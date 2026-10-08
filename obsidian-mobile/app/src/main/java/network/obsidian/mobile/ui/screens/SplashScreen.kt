package network.obsidian.mobile.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import network.obsidian.mobile.R
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianType

/**
 * Launch splash — artboard 00, "Launch Splash (animated)".
 *
 * Reproduced from the supplied design: the canvas background, the logo, the
 * OBSIDIAN NETWORK wordmark, "THE PROOF OF TIME BLOCKCHAIN" beneath it and the
 * "Build. Validate. Decentralize." line, with the artboard's slow breathing
 * animation on the mark.
 *
 * It leaves on a fixed delay and never waits on the network. Gating the splash on
 * a node answering would leave a user with no chain connection staring at a logo
 * with no way out — and the whole point of the offline states elsewhere in the app
 * is that being unable to reach a node is a condition the UI describes, not one it
 * hangs on.
 */
@Composable
fun SplashScreen(onFinished: () -> Unit) {
    val transition = rememberInfiniteTransition(label = "splash")
    val breathe by transition.animateFloat(
        initialValue = 0.86f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1600), RepeatMode.Reverse),
        label = "breathe",
    )

    LaunchedEffect(Unit) {
        delay(SPLASH_MILLIS)
        onFinished()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ObsidianColors.Canvas),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Image(
                painter = painterResource(R.drawable.obsidian_logo),
                contentDescription = "Obsidian",
                modifier = Modifier
                    .size(112.dp)
                    .alpha(breathe),
                contentScale = ContentScale.Fit,
            )
            Spacer(Modifier.height(22.dp))
            Text(
                "OBSIDIAN NETWORK",
                style = ObsidianType.Statement,
                color = ObsidianColors.Ink,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "THE PROOF OF TIME BLOCKCHAIN",
                style = ObsidianType.Kicker,
                color = ObsidianColors.GoldText,
            )
            Spacer(Modifier.height(14.dp))
            Text(
                "Build. Validate. Decentralize.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }
    }
}

/** Long enough to be seen as a deliberate brand moment, short enough to never
 *  feel like the app is stuck. */
private const val SPLASH_MILLIS = 1_400L
