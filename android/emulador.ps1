# Inicia o emulador Android (D:\Android) e instala o APK de debug do Welcomely.
# Requer virtualização ligada na BIOS (Intel VT-x) e a "Plataforma do Hipervisor do Windows" ativada.
# Uso:  .\emulador.ps1             (cria o AVD se faltar, inicia, instala e abre o app)
#       .\emulador.ps1 -SoCriar    (só cria o AVD)
param([switch]$SoCriar)
# 'Continue': no PowerShell 5.1, avisos no stderr das ferramentas do SDK virariam erro fatal com 'Stop'.
# Os códigos de saída são conferidos explicitamente.
$ErrorActionPreference = 'Continue'

$tools = 'D:\Android'
$env:JAVA_HOME = "$tools\jdk17"
$env:ANDROID_HOME = "$tools\sdk"
$env:ANDROID_SDK_ROOT = "$tools\sdk"
$env:ANDROID_AVD_HOME = "$tools\avd"     # AVDs junto das outras ferramentas, não em %USERPROFILE%\.android
$env:TMP = "$tools\tmp"
$env:TEMP = "$tools\tmp"
$avd = 'Welcomely_API36'
$image = 'system-images;android-36;google_apis;x86_64'
$adb = "$tools\sdk\platform-tools\adb.exe"
$emulator = "$tools\sdk\emulator\emulator.exe"

New-Item -ItemType Directory -Force $env:ANDROID_AVD_HOME, $env:TMP | Out-Null
if (-not (Test-Path "$env:ANDROID_AVD_HOME\$avd.avd")) {
    'no' | & "$tools\sdk\cmdline-tools\latest\bin\avdmanager.bat" create avd -n $avd -k $image -d pixel_6 --force
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar o AVD $avd" }
    Write-Output "AVD criado: $avd"
}
if ($SoCriar) { return }

$accel = & $emulator -accel-check 2>&1 | Out-String
if ($accel -notmatch 'is installed and usable') {
    throw "Aceleração de hardware indisponível; o emulador não vai iniciar.`n$accel"
}

if (-not ((& $adb devices) -match '^emulator-')) {
    Start-Process $emulator -ArgumentList "-avd $avd -no-snapshot-save -no-boot-anim" -WindowStyle Normal
    Write-Output 'Iniciando o emulador...'
    & $adb wait-for-device
    do { Start-Sleep 2 } until ((& $adb shell getprop sys.boot_completed 2>$null) -match '1')
}

$apk = Get-ChildItem (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'apk\Welcomely-*-debug.apk') |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
& $adb install -r $apk.FullName
& $adb shell am start -n io.github.fermatools.welcomely.debug/io.github.fermatools.welcomely.MainActivity
Write-Output "App aberto no emulador ($($apk.Name)). O servidor deve estar rodando no PC (codigo\servidor.bat)."
