plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

// Opcional: -PbuildRoot=<pasta> coloca os arquivos de build fora da pasta do projeto
// (útil quando o projeto está numa pasta sincronizada, como o Google Drive).
providers.gradleProperty("buildRoot").orNull?.let { root ->
    allprojects { layout.buildDirectory.set(file("$root/${project.name}")) }
}
