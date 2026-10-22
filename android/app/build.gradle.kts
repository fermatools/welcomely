plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Endereço do app web aberto pelo app Android. Padrão: o site publicado no GitHub Pages.
// Para testar outra cópia: .\build.ps1 -Servidor http://... (ou -PserverUrl=...).
// O usuário também pode trocar o endereço no próprio app (tela "Sobre" ou tela de erro).
val serverUrl = providers.gradleProperty("serverUrl").getOrElse("https://fermatools.github.io/welcomely/")

android {
    namespace = "io.github.fermatools.welcomely"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.fermatools.welcomely"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
        manifestPlaceholders["appLabel"] = "@string/app_name"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Por enquanto assinado com a chave de debug desta máquina (instalação direta do APK).
            signingConfig = signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["appLabel"] = "Welcomely (debug)"
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
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
}
