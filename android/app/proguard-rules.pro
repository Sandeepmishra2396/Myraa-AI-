# MYRAA Android Companion — ProGuard / R8 Rules
# Phase 30 — Production Hardening & Release Readiness

# ═══════════════════════════════════════════════════════════════════════════════
# 1. MYRAA COMPANION APPLICATION & MODELS
# ═══════════════════════════════════════════════════════════════════════════════

# Keep all data models, contracts, and capability payloads to prevent reflection serialization failures
-keep class com.myraa.companion.** { *; }
-keep class com.myraa.companion.capabilities.** { *; }
-keep class com.myraa.companion.networking.** { *; }
-keep class com.myraa.companion.security.** { *; }
-keep class com.myraa.companion.voice.** { *; }
-keep class com.myraa.companion.ui.** { *; }
-keep class com.myraa.companion.service.** { *; }
-keep class com.myraa.companion.MyraaApplication { *; }

# Keep companion objects for reflection and instantiation
-keepclassmembers class * {
    public static ** Companion;
}

# ═══════════════════════════════════════════════════════════════════════════════
# 2. OKHTTP3 & OKIO (WebSocket & REST Networking)
# ═══════════════════════════════════════════════════════════════════════════════

-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }
-keep class okio.** { *; }
-keep interface okio.** { *; }

# ═══════════════════════════════════════════════════════════════════════════════
# 3. ANDROIDX SECURITY CRYPTO & KEYSTORE INTEROP
# ═══════════════════════════════════════════════════════════════════════════════

-keep class androidx.security.crypto.** { *; }
-dontwarn androidx.security.crypto.**
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**

# ═══════════════════════════════════════════════════════════════════════════════
# 4. KOTLIN COROUTINES & FLOW
# ═══════════════════════════════════════════════════════════════════════════════

-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembernames class kotlinx.coroutines.** {
    volatile <fields>;
}

# ═══════════════════════════════════════════════════════════════════════════════
# 5. JETPACK COMPOSE RUNTIME
# ═══════════════════════════════════════════════════════════════════════════════

-keep class androidx.compose.runtime.** { *; }
-dontwarn androidx.compose.runtime.**

# ═══════════════════════════════════════════════════════════════════════════════
# 6. PRODUCTION BYTECODE LOG STRIPPING
# ═══════════════════════════════════════════════════════════════════════════════

# Strip verbose and debug logging calls completely at bytecode level in release builds
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
}
