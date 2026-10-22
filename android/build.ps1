# Compila o APK do Welcomely usando as ferramentas instaladas em D:\Android (as mesmas do Reader Voice).
# Uso:  .\build.ps1                                   (debug, servidor padrão http://10.0.2.2:5000 = PC visto do emulador)
#       .\build.ps1 -Servidor http://192.168.0.10:5000 (debug apontando para o PC na rede local)
#       .\build.ps1 -Release -Servidor https://...    (release; em produção use HTTPS)
param([switch]$Release, [string]$Servidor)
$ErrorActionPreference = 'Stop'

$tools = 'D:\Android'
$env:JAVA_HOME = "$tools\jdk17"
$env:ANDROID_HOME = "$tools\sdk"
$env:GRADLE_USER_HOME = "$tools\gradle-home"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
# O Java 17 no Windows falha ("Unable to establish loopback connection") quando a pasta
# TEMP do usuário tem um caminho problemático; usa uma pasta temporária curta.
$tmp = "$tools\tmp"
New-Item -ItemType Directory -Force $tmp | Out-Null
$env:TMP = $tmp
$env:TEMP = $tmp
$env:GRADLE_OPTS = "-Djdk.net.unixdomain.tmpdir=$tmp -Djava.io.tmpdir=$tmp"

# Build fora do Google Drive, para não sincronizar arquivos temporários.
$buildRoot = "$tools\builds\Welcomely"
$task = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
$variant = if ($Release) { 'release' } else { 'debug' }
$extra = @()
if ($Servidor) { $extra += "-PserverUrl=$Servidor" }

Push-Location $PSScriptRoot
try {
    & .\gradlew.bat $task @extra "-PbuildRoot=$buildRoot" --project-cache-dir "$buildRoot\.gradle"
    if ($LASTEXITCODE -ne 0) { throw "Falha no build (código $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$apk = Get-ChildItem "$buildRoot\app\outputs\apk\$variant\*.apk" | Select-Object -First 1
$gradleFile = Get-Content (Join-Path $PSScriptRoot 'app\build.gradle.kts') -Raw
$version = [regex]::Match($gradleFile, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value
# APKs ficam na pasta do projeto Claude, fora do repositório (codigo/).
$outDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'apk'
New-Item -ItemType Directory -Force $outDir | Out-Null
$dest = Join-Path $outDir "Welcomely-$version-$variant.apk"
Copy-Item $apk.FullName $dest -Force
Write-Output "APK gerado: $dest"
