# Welcomely

Agendamento de atendimentos para quem atende (profissionais liberais, sacerdotes, consultores…),
para suas secretárias e para os clientes. Funciona no navegador (PWA instalável) e como app Android.

**App:** https://fermatools.github.io/welcomely/

Um app **FERMATools** · fermatools@gmail.com · https://fermatools.github.io/

## Perfis

| Perfil | O que faz |
|---|---|
| **Cliente** | Busca profissionais, escolhe o tipo de atendimento, o dia e um horário livre; acompanha e cancela os seus agendamentos. |
| **Profissional** | Agenda do dia/semana, confirma pedidos, marca concluído/falta, remarca; cadastra serviços (com duração), horários semanais e bloqueios (férias etc.); define regras (confirmação manual, antecedência mínima, janela de agendamento, prazo de cancelamento); adiciona auxiliares; compartilha seu link de agendamento. |
| **Auxiliar** (secretaria) | Gerencia a agenda dos profissionais que o adicionaram à equipe: agenda clientes (com ou sem conta, inclusive encaixes fora da grade), confirma, remarca, cancela, edita serviços, horários e bloqueios. |

## Arquitetura

App web estático (HTML/CSS/JS sem etapa de build), publicado no **GitHub Pages**, com os dados no
**Firebase** (Authentication com e-mail/senha + Firestore). Não há servidor próprio.

```
web/                 app web (PWA) — é o que vai para o GitHub Pages
  js/api.js            regras do app (validação, permissões, horários livres, reservas)
  js/data/logic.js     funções puras (cálculo de horários, sobreposição, datas)
  js/data/store-*.js   armazenamento: Firebase ou demonstração (localStorage)
  js/firebase-config.js  configuração do projeto Firebase (vazia = modo demonstração)
  js/views/            telas: auth, cliente, agenda, gestao (serviços/horários/equipe), conta
firestore.rules      regras de segurança do Firestore (quem pode ler/escrever o quê)
android/             app Android (Kotlin): abre o app web numa WebView
tools/gen_icons.py   gera os ícones
publicar.ps1         publica no GitHub (main + pasta web/ na branch gh-pages)
```

Reservas sem conflito: cada profissional tem um documento por dia com os horários ocupados (sem dados
pessoais); a reserva é feita numa transação sobre esse documento, então duas pessoas não conseguem pegar
o mesmo horário.

### Modo demonstração

Enquanto `web/js/firebase-config.js` estiver vazio (ou com `?demo` no endereço), o app funciona sem
Firebase: as contas e os agendamentos ficam só no navegador, com contas de exemplo (senha `demo123`).

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
.\servidor.bat        # http://localhost:5000  (servidor de arquivos do Python; Ctrl+C para parar)
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
