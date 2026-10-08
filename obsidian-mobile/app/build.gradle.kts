plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * The operator's release keystore, when one is configured.
 *
 * Checked for blank as well as null: CI passes secrets through as empty strings
 * when they are unset, and `file("")` fails with "path may not be null or empty
 * string" — which reads like a build-system bug rather than the truth, that no
 * signing key was supplied. Absent means the release build is emitted unsigned.
 */
val releaseKeystorePath: String? = System.getenv("OBSIDIAN_KEYSTORE")?.takeIf { it.isNotBlank() }

android {
    namespace = "network.obsidian.mobile"
    compileSdk = 34

    defaultConfig {
        // Internal project: Obsidian Mobile. User-facing label: OBSIDIAN.
        applicationId = "network.obsidian.mobile"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // The protocol this client speaks. Bumping it is a deliberate act, not a
        // side effect: it must track obsidian-core's PROTOCOL_VERSION.
        buildConfigField("String", "TARGET_PROTOCOL_VERSION", "\"1.6.1\"")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        // A release key is supplied by the operator through CI secrets or a local
        // keystore. Nothing is generated here and no key is ever committed: an
        // APK signed by a key the project itself created would prove nothing.
        create("release") {
            if (releaseKeystorePath != null) {
                storeFile = file(releaseKeystorePath)
                storePassword = System.getenv("OBSIDIAN_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("OBSIDIAN_KEY_ALIAS")
                keyPassword = System.getenv("OBSIDIAN_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed only when the operator supplied a key; otherwise Gradle emits
            // an unsigned archive and CI publishes the debug APK instead, labelled
            // as such rather than pretending to be a production signature.
            signingConfig = if (releaseKeystorePath != null) {
                signingConfigs.getByName("release")
            } else {
                null
            }
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/DEPENDENCIES")
    }

    // The design is a fixed 390px-wide mobile artboard; the app is portrait-first
    // but must not lose state on rotation (requirement 31).
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.androidx.navigation.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.datastore.preferences)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
