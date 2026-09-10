plugins { id("com.android.application") }

android {
    namespace = "help.xminute.neteasecompanion"
    compileSdk = 35

    defaultConfig {
        applicationId = "help.xminute.neteasecompanion"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.1.2"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
