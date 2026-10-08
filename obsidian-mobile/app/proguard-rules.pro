# Keep the kotlinx.serialization metadata: the generated serializers are looked
# up reflectively, and stripping them turns every API response into a crash.
-keepattributes *Annotation*, InnerClasses, Signature
-keepclassmembers class **$$serializer { *; }
-keepclasseswithmembers class network.obsidian.mobile.data.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    *** Companion;
    *** INSTANCE;
}
# OkHttp ships optional references to Conscrypt/BouncyCastle that are absent on
# Android; the warnings are expected and must not fail the build.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
