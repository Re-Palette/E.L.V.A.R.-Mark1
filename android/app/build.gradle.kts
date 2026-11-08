plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.elvar.mark1"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.elvar.mark1"
        minSdk = 29            // Android 10+: the "default digital assistant" role
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        // The deployed E.L.V.A.R. URL. Build with -PelvarUrl=https://... (blank = the app asks on first launch).
        buildConfigField("String", "ELVAR_URL", "\"${(project.findProperty("elvarUrl") ?: "").toString().trim()}\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        // A fixed (non-secret) debug key, so every build is signed the same and updates install over the old app.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("debug") }
        getByName("release") { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("debug") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
