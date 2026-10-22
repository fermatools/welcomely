# Publica o Welcomely no GitHub (repositório fermatools/welcomely):
#   - envia a branch main (código);
#   - envia a pasta web/ como branch gh-pages, que o GitHub Pages serve em https://fermatools.github.io/welcomely/
# Usa a conta "fermatools" do gh só durante o envio e depois volta para a conta que estava ativa.
# Uso:  .\publicar.ps1
$ErrorActionPreference = 'Continue'   # git escreve progresso no stderr
Push-Location $PSScriptRoot
$anterior = (gh api user --jq .login)
try {
    if (git status --porcelain) { throw 'Há alterações sem commit. Faça o commit antes de publicar.' }
    gh auth switch --user fermatools | Out-Null
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao enviar a main.' }
    git branch -f gh-pages (git subtree split --prefix web main)
    git push origin gh-pages --force
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao enviar a gh-pages.' }
    Write-Output 'Publicado. O GitHub Pages atualiza em 1 a 2 minutos: https://fermatools.github.io/welcomely/'
} finally {
    if ($anterior -and $anterior -ne 'fermatools') { gh auth switch --user $anterior | Out-Null }
    Pop-Location
}
