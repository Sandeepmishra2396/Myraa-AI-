// MYRAA Android Companion — App Module Build Configuration
// Phase 15: Project scaffold with correct compile/target API levels

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.myraa.companion"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.myraa.companion"
        minSdk = 26   // Android 8.0 — required for AudioRecord.Builder and modern crypto APIs
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            val keystorePath = System.getenv("MYRAA_RELEASE_KEYSTORE_PATH")
                ?: (project.findProperty("MYRAA_RELEASE_KEYSTORE_PATH") as? String)
            val storePass = System.getenv("MYRAA_RELEASE_STORE_PASSWORD")
                ?: (project.findProperty("MYRAA_RELEASE_STORE_PASSWORD") as? String)
            val keyAliasStr = System.getenv("MYRAA_RELEASE_KEY_ALIAS")
                ?: (project.findProperty("MYRAA_RELEASE_KEY_ALIAS") as? String)
                ?: "myraa_release_key"
            val keyPass = System.getenv("MYRAA_RELEASE_KEY_PASSWORD")
                ?: (project.findProperty("MYRAA_RELEASE_KEY_PASSWORD") as? String)
                ?: storePass

            if (!keystorePath.isNullOrBlank() && !storePass.isNullOrBlank()) {
                val kFile = file(keystorePath)
                if (kFile.exists()) {
                    storeFile = kFile
                    storePassword = storePass
                    keyAlias = keyAliasStr
                    keyPassword = keyPass
                }
            }
        }
        create("releaseTest") {
            // Dedicated staging/test variant for local testing without production keys
            val debugKeystore = file("${System.getProperty("user.home")}/.android/debug.keystore")
            if (debugKeystore.exists()) {
                storeFile = debugKeystore
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        create("releaseTest") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            signingConfig = signingConfigs.getByName("releaseTest")
            versionNameSuffix = "-test"
        }
        debug {
            isMinifyEnabled = false
            // versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    // AndroidX Core
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.activity.compose)

    // Jetpack Compose
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)

    // OkHttp3 — WebSocket streaming to MYRAA Core /remote-live endpoint
    // Full-duplex: 16kHz PCM16 up / 24kHz PCM16 down over ws(s)://<desktop>:3000/remote-live
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)

    // AndroidX Security Crypto — Keystore-backed EncryptedSharedPreferences
    // Stores sora_dev_... bearer tokens with Android Keystore AES-256-GCM
    implementation(libs.security.crypto)

    // Coroutines
    implementation(libs.kotlinx.coroutines.android)

    // Debug tools
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    // Tests
    testImplementation(libs.junit)
    androidTestImplementation(libs.junit.ext)
    androidTestImplementation(libs.espresso.core)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION SIGNING FAIL-CLOSED ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════
// assembleRelease / bundleRelease MUST have valid production signing credentials.
// If credentials or keystore are missing, the build fails closed immediately.
gradle.taskGraph.whenReady {
    val hasProductionReleaseTask = allTasks.any { task ->
        val name = task.name.lowercase()
        (name.contains("assemblerelease") || name.contains("bundlerelease") || name.contains("packagerelease")) &&
        !name.contains("releasetest")
    }
    if (hasProductionReleaseTask) {
        val relConfig = android.signingConfigs.getByName("release")
        val store = relConfig.storeFile
        if (store == null || !store.exists()) {
            throw GradleException(
                "PRODUCTION SIGNING FAILURE: Production release build requires valid signing credentials.\n" +
                "Set MYRAA_RELEASE_KEYSTORE_PATH and MYRAA_RELEASE_STORE_PASSWORD environment variables.\n" +
                "For local testing without production keys, use 'assembleReleaseTest' or 'assembleDebug'."
            )
        }
    }
}

