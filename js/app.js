import { DEMO, store } from './api.js';
import { go, homeFor, loadMe, saveRedirect, state } from './state.js';
import { esc, icon, spinner, toast } from './ui.js';
import * as agenda from './views/agenda.js';
import * as auth from './views/auth.js';
import * as cliente from './views/cliente.js';
import * as conta from './views/conta.js';
import * as gestao from './views/gestao.js';
import * as grupos from './views/grupos.js';

const MANAGERS = ['profissional', 'auxiliar', 'admin'];
const GROUP_STAFF = ['profissional', 'auxiliar', 'admin'];

const NAV = {
  cliente: [['#/buscar', 'Buscar', 'search'], ['#/meus', 'Agendamentos', 'calendar'], ['#/conta', 'Conta', 'user']],
  profissional: [['#/agenda', 'Agenda', 'calendar'], ['#/servicos', 'Serviços', 'list'], ['#/horarios', 'Horários', 'clock'],
    ['#/grupos', 'Grupos', 'users'], ['#/conta', 'Conta', 'user']],
  auxiliar: [['#/agenda', 'Agenda', 'calendar'], ['#/servicos', 'Serviços', 'list'], ['#/horarios', 'Horários', 'clock'],
    ['#/grupos', 'Grupos', 'users'], ['#/conta', 'Conta', 'user']],
  admin: [['#/grupos', 'Grupos', 'users'], ['#/agenda', 'Agendas', 'calendar'], ['#/conta', 'Conta', 'user']],
};

// [padrão, view, opções]. public: abre sem login; roles: perfis que podem abrir.
const ROUTES = [
  [/^\/entrar$/, auth.login, { public: true, bare: true }],
  [/^\/cadastro(?:\/([\w-]+))?$/, auth.register, { public: true, bare: true }],
  [/^\/convite\/([\w-]+)$/, grupos.invite, { public: true }],
  [/^\/sobre$/, conta.about, { public: true }],
  [/^\/p\/([\w-]+)$/, cliente.professionalPage, {}],
  [/^\/buscar$/, cliente.search, {}],
  [/^\/meus$/, cliente.mine, {}],
  [/^\/agenda$/, agenda.agenda, { roles: MANAGERS }],
  [/^\/servicos$/, gestao.services, { roles: MANAGERS }],
  [/^\/horarios$/, gestao.hours, { roles: MANAGERS }],
  [/^\/grupos$/, grupos.list, { roles: GROUP_STAFF }],
  [/^\/grupos\/([\w-]+)$/, grupos.detail, { roles: GROUP_STAFF }],
  [/^\/conta$/, conta.account, {}],
];

const root = document.getElementById('app');

const demoBanner = () => (DEMO ? `<div class="demo-banner">Modo demonstração: os dados ficam só neste navegador.
  <a href="#/sobre">Saiba mais</a></div>` : '');

function layout(path, bare) {
  if (bare) {
    root.innerHTML = `${demoBanner()}<main id="view" class="bare"></main>`;
    return root.querySelector('#view');
  }
  const items = state.user ? NAV[state.user.role] : [];
  const links = (cls) => items.map(([href, label, ic]) => `
    <a href="${href}" class="${cls}${path === href.slice(1) ? ' active' : ''}">${icon(ic)}<span>${label}</span></a>`).join('');
  root.innerHTML = `${demoBanner()}
    <header class="topbar">
      <a class="brand" href="${homeFor(state.user)}"><img src="icons/icon.svg" alt="" width="30" height="30"><span>Welcomely</span></a>
      <nav class="topnav">${links('topnav-link')}</nav>
      ${state.user ? `<span class="who" title="${esc(state.user.email)}">${esc(state.user.name.split(' ')[0])}</span>`
        : '<a class="btn small primary" href="#/entrar">Entrar</a>'}
    </header>
    <main id="view">${spinner()}</main>
    ${items.length ? `<nav class="bottomnav">${links('bottomnav-link')}</nav>` : ''}`;
  return root.querySelector('#view');
}

async function render() {
  const path = location.hash.replace(/^#/, '') || '/';
  if (path === '/') return go(homeFor(state.user));

  for (const [pattern, view, opts] of ROUTES) {
    const match = path.match(pattern);
    if (!match) continue;
    if (!opts.public && !state.user) {
      saveRedirect(location.hash);
      return go('#/entrar');
    }
    if (opts.roles && !opts.roles.includes(state.user.role)) return go(homeFor(state.user));
    if (opts.bare && state.user) return go(homeFor(state.user));
    const el = layout(path, opts.bare);
    window.scrollTo(0, 0);
    try {
      await view(el, ...match.slice(1));
    } catch (err) {
      el.innerHTML = `<div class="page"><div class="card error-box">${esc(err.message)}</div></div>`;
    }
    return undefined;
  }
  return go(homeFor(state.user));
}

window.addEventListener('hashchange', render);

async function start() {
  await store.ready();   // o Firebase restaura a sessão de forma assíncrona
  if (store.uid()) {
    try { await loadMe(); } catch (err) { toast(err.message, 'error'); }
  }
  render();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
