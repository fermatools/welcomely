@echo off
rem Serve o app web do Welcomely localmente para testes:  http://localhost:5000
rem O app e estatico (dados no Firebase, ou no navegador em modo demonstracao),
rem entao basta o Python, sem bibliotecas extras.
rem Uso: servidor.bat   (ou dois cliques).  Modo demonstracao: http://localhost:5000/?demo
setlocal
cd /d "%~dp0"
python tools\servidor.py 5000
if errorlevel 1 pause
