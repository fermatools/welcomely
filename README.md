# Welcomely

Agendamento de atendimentos para quem atende (profissionais liberais, sacerdotes, consultores…),
para suas secretárias e para os clientes. Funciona no navegador (PWA instalável) e como app Android.

Um app **FERMATools** · fermatools@gmail.com · https://fermatools.github.io/

## Perfis

| Perfil | O que faz |
|---|---|
| **Cliente** | Busca profissionais, escolhe o tipo de atendimento, o dia e um horário livre; acompanha e cancela os seus agendamentos. |
| **Profissional** | Agenda do dia/semana, confirma pedidos, marca concluído/falta, remarca; cadastra serviços (com duração), horários semanais e bloqueios (férias etc.); define regras (confirmação manual, antecedência mínima, janela de agendamento, prazo de cancelamento); adiciona auxiliares; compartilha seu link de agendamento. |
| **Auxiliar** (secretaria) | Gerencia a agenda de um ou mais profissionais que o adicionaram à equipe: agenda clientes (com ou sem conta, inclusive encaixes fora da grade), confirma, remarca, cancela, edita serviços, horários e bloqueios. |

## Estrutura

```
server/     API em Python (Flask + SQLite) que também serve o app web
  app.py      rotas /api/... e arquivos estáticos
  db.py       esquema do banco
  slots.py    cálculo de horários livres
  seed.py     contas de demonstração
  tests/      testes da API (unittest)
web/        app web (HTML/CSS/JS puro, sem etapa de build) — PWA
  js/views/   telas: auth, cliente, agenda, gestao (serviços/horários/equipe), conta
android/    app Android (Kotlin): abre o app web numa WebView
tools/      gen_icons.py (gera os ícones)
```

## Rodar localmente

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r server\requirements.txt
cd server
..\.venv\Scripts\python seed.py          # opcional: contas de demonstração (senha demo123)
..\.venv\Scripts\python app.py           # http://localhost:5000
```

Contas de demonstração: `ana@demo.welcomely` e `joao@demo.welcomely` (profissionais),
`maria@demo.welcomely` (auxiliar dos dois), `carlos@demo.welcomely` (cliente).

Variáveis de ambiente: `WELCOMELY_DB` (caminho do banco), `WELCOMELY_TZ` (fuso, padrão
`America/Sao_Paulo`), `PORT`, `HOST`.

Testes: `cd server; ..\.venv\Scripts\python -m unittest discover -s tests`

## Android

`android/` é um app nativo mínimo que carrega o app web do servidor (links de WhatsApp,
telefone e e-mail abrem nos apps do aparelho; "Compartilhar" usa o menu do Android).

```powershell
cd android
.\build.ps1                                      # debug, servidor http://10.0.2.2:5000 (emulador)
.\build.ps1 -Servidor http://192.168.0.10:5000   # debug, servidor no PC da rede local
.\build.ps1 -Release -Servidor https://seu-servidor
```

Usa as ferramentas em `D:\Android` (JDK 17, SDK, cache do Gradle); o build fica em
`D:\Android\builds\Welcomely` e o APK é copiado para `..\apk\` (fora do repositório).
O endereço do servidor também pode ser trocado no app (tela **Sobre**, ou na tela de erro de conexão).
No release só é aceito HTTPS (exceto `10.0.2.2`/`localhost`).

Sem o app, o Welcomely também pode ser instalado pelo Chrome do Android: abrir o endereço do
servidor (com HTTPS) → menu → **Instalar app**.

## Publicação (pendente)

O servidor precisa estar num endereço público com HTTPS para os celulares acessarem. Opções
simples: um VPS com `waitress`/`gunicorn` atrás de um proxy com TLS, ou serviços como
Render/Fly.io/PythonAnywhere (o banco SQLite precisa de disco persistente).
