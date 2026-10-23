# Welcomely

Agendamento de atendimentos e consultorias. Funciona no navegador (PWA instalável) e como app Android.

**App:** https://fermatools.github.io/welcomely/

Um app **FERMATools** · fermatools@gmail.com · https://fermatools.github.io/

## Perfis e grupos

| Perfil | O que faz |
|---|---|
| **Administrador** | Conta definida em `web/js/config.js` (só o hash do e-mail; vale com o e-mail confirmado). Cria grupos, cadastra qualquer pessoa em qualquer grupo e vê todas as agendas. |
| **Atendente** | Agenda do dia/semana, confirma, remarca, marca concluído/falta; serviços; horários por regras de repetição (toda semana, a cada N semanas, n-ésimo dia do mês, data única, com validade) e bloqueios; regras de agendamento. Cadastra auxiliares e clientes nos seus grupos e vê só as pessoas desses grupos. Pode estar em vários grupos. |
| **Auxiliar** (secretaria) | Gerencia a agenda dos atendentes dos seus grupos (agenda clientes com ou sem conta, encaixes, confirma, remarca). Cadastra clientes nos seus grupos. |
| **Cliente** | Agenda só com atendentes dos seus grupos; acompanha e cancela os seus agendamentos. |

Pedidos de clientes ficam **pendentes** (amarelo) até o atendente ou o auxiliar confirmar (verde), a menos
que o atendente desligue a confirmação. Cada agendamento tem **Adicionar à agenda** (Google Agenda, arquivo
.ics para Apple/Outlook ou, no app Android, o calendário do celular); a agenda exporta o dia/semana em .ics.
Ao confirmar, remarcar, cancelar ou agendar pela agenda, o app oferece **avisar o cliente** por e-mail ou
WhatsApp: abre o e-mail/WhatsApp de quem está usando, com a mensagem pronta (inclui o link do Google Agenda).

Não há cadastro aberto: a pessoa é cadastrada por alguém (e recebe um e-mail para criar a própria senha) ou
cria a conta de cliente pelo **link de convite** de um grupo (`#/convite/<grupo>`, na tela do grupo).

## Arquitetura

App web estático (HTML/CSS/JS sem etapa de build), publicado no **GitHub Pages**, com os dados no
**Firebase** (Authentication com e-mail/senha + Firestore). Não há servidor próprio.

```
web/                 app web (PWA) — é o que vai para o GitHub Pages
  js/api.js            regras do app (validação, permissões, horários livres, reservas)
  js/data/logic.js     funções puras (cálculo de horários, sobreposição, datas)
  js/data/store-*.js   armazenamento: Firebase ou demonstração (localStorage)
  js/firebase-config.js  configuração do projeto Firebase (vazia = modo demonstração)
  js/views/            telas: auth, cliente, agenda, gestao (serviços/horários), grupos, conta
firestore.rules      regras de segurança do Firestore (quem pode ler/escrever o quê)
android/             app Android (Kotlin): abre o app web numa WebView
tools/gen_icons.py   gera os ícones
publicar.ps1         publica no GitHub (main + pasta web/ na branch gh-pages)
```

Reservas sem conflito: cada profissional tem um documento por dia com os horários ocupados (sem dados
pessoais); a reserva é feita numa transação sobre esse documento, então duas pessoas não conseguem pegar
o mesmo horário.

### Modo demonstração

Com `?demo` no endereço (ou com `web/js/firebase-config.js` vazio), o app funciona sem Firebase: as contas e
os agendamentos ficam só no navegador, com contas de exemplo de cada perfil (senha `demo123`).
Ex.: https://fermatools.github.io/welcomely/?demo

## Configurar o Firebase (uma vez)

1. Em https://console.firebase.google.com, criar o projeto (ex.: `welcomely`).
2. **Authentication** → Começar → **E-mail/senha** → Ativar. Em *Modelos*, pôr o idioma em português.
3. **Firestore Database** → Criar banco de dados → modo de produção → região `southamerica-east1`.
4. **Firestore → Regras**: colar o conteúdo de `firestore.rules` e **Publicar** (repetir sempre que o arquivo mudar).
5. **Configurações do projeto** → Seus apps → **Web** (`</>`) → registrar → copiar o `firebaseConfig`
   para `web/js/firebase-config.js`.
6. (Recomendado) Google Cloud Console → APIs e serviços → Credenciais → a chave de API do navegador →
   restringir por referenciador HTTP: `fermatools.github.io/*` e `localhost:5000/*`.

Se o Firestore pedir um índice ao listar agendamentos, a mensagem de erro no console do navegador traz o
link que cria o índice com um clique.

## Publicar

```powershell
.\publicar.ps1       # envia a main e a pasta web/ (branch gh-pages) para fermatools/welcomely
```

O GitHub Pages serve a branch `gh-pages` em https://fermatools.github.io/welcomely/.

## Rodar localmente

```powershell
.\servidor.bat        # http://localhost:5000  (tools/servidor.py, sem cache; Ctrl+C para parar)
```

`http://localhost:5000/?demo` força o modo demonstração mesmo com o Firebase configurado.

## Android

`android/` é um app nativo mínimo que abre o app web publicado (links de WhatsApp, telefone e e-mail abrem
nos apps do aparelho; "Compartilhar" usa o menu do Android). O endereço também pode ser trocado no app
(tela **Sobre** ou na tela de erro de conexão).

```powershell
cd android
.\build.ps1                                     # debug, abre https://fermatools.github.io/welcomely/
.\build.ps1 -Servidor http://192.168.0.10:5000  # debug, abre a cópia local servida pelo PC
.\build.ps1 -Release
.\emulador.ps1                                  # inicia o emulador e instala o APK de debug
```

Usa as ferramentas em `D:\Android` (JDK 17, SDK, cache do Gradle); o build fica em
`D:\Android\builds\Welcomely` e o APK é copiado para `..\apk\` (fora do repositório). O emulador exige
virtualização ligada na BIOS e a Plataforma do Hipervisor do Windows ativada.

Sem o APK, o Welcomely também pode ser instalado pelo Chrome do Android: abrir o endereço do app →
menu → **Instalar app**.
