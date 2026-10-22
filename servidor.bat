@echo off
rem Serve o app web do Welcomely localmente para testes:  http://localhost:5000
rem O app e estatico (dados no Firebase, ou no navegador em modo demonstracao),
rem entao basta o servidor de arquivos do Python, sem bibliotecas extras.
rem Uso: servidor.bat   (ou dois cliques).  Modo demonstracao forcado: http://localhost:5000/?demo
setlocal
cd /d "%~dp0web"
echo Welcomely em http://localhost:5000  (Ctrl+C para parar)
python -m http.server 5000 --bind 0.0.0.0
if errorlevel 1 pause
