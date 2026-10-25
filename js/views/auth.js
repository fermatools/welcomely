import * as api from '../api.js';
import { go, homeFor, loadMe, state, takeRedirect } from '../state.js';
import { busy, esc, formData, icon, toast } from '../ui.js';

function hero() {
  return `
    <div class="auth-hero">
      <img src="icons/icon.svg" alt="" width="64" height="64">
      <h1>Welcomely</h1>
      <p>Agende atendimentos sem troca de mensagens.</p>
    </div>`;
}

async function finish() {
  await loadMe();
  go(takeRedirect() || homeFor(state.user));
}

// Botão "Entrar com o Google": só no navegador. O Google bloqueia esse login dentro do app Android (WebView)
// e a demonstração não tem Firebase.
const googleAvailable = () => !api.DEMO && !window.WelcomelyAndroid;
const GOOGLE_G = `<svg class="google-g" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.77.9 7.35 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

function googleBlock(label) {
  if (!googleAvailable()) return '';
  return `<button type="button" class="btn block google-btn" id="google">${GOOGLE_G} ${label}</button>
    <p class="divider"><span>ou com e-mail e senha</span></p>`;
}

function bindGoogle(el, invite) {
  el.querySelector('#google')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api.loginWithGoogle(invite);
    await finish();
  }));
}

async function demoAccounts() {
  if (!api.DEMO) return '';
  const { DEMO_ACCOUNTS } = await import('../data/store-demo.js');
  return `
    <section class="card demo-box">
      <h2>Experimente</h2>
      <p class="muted small">Entre com uma conta de exemplo:</p>
      <div class="demo-accounts">${DEMO_ACCOUNTS.map(([email, label]) => `
        <button type="button" class="btn small" data-demo="${esc(email)}">${esc(label)}</button>`).join('')}</div>
    </section>`;
}

export async function login(el) {
  el.innerHTML = `
    <div class="auth">
      ${hero()}
      <form class="card auth-card" novalidate>
        <h2>Entrar</h2>
        ${googleBlock('Entrar com o Google')}
        <label>E-mail<input name="email" type="email" autocomplete="email" required></label>
        <label>Senha<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary block" type="submit">Entrar</button>
        <p class="center"><button type="button" class="link muted small" id="forgot">Esqueci minha senha</button></p>
        <p class="muted small center">Ainda não tem conta? Peça o link de convite ao seu atendente.</p>
      </form>
      ${await demoAccounts()}
      <p class="center"><a class="muted" href="#/sobre">Sobre o Welcomely</a></p>
    </div>`;
  const form = el.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    busy(form.querySelector('[type=submit]'), async () => {
      await api.login(formData(form));
      await finish();
    });
  });
  bindGoogle(el, null);
  el.querySelector('#forgot').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api.resetPassword(form.elements.email.value);
    toast('Enviamos um e-mail com o link para criar uma nova senha. Se não chegar, procure no spam.');
  }));
  el.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    const { DEMO_PASSWORD } = await import('../data/store-demo.js');
    await api.login({ email: b.dataset.demo, password: DEMO_PASSWORD });
    await finish();
  })));
}

export async function register(el, invite) {
  const group = invite ? await api.getInvite(invite).catch(() => null) : null;
  el.innerHTML = `
    <div class="auth">
      ${hero()}
      <form class="card auth-card" novalidate>
        <h2>Criar conta</h2>
        ${group ? `<p class="note-inline">${icon('users')} Você vai entrar em <b>${esc(group.name)}</b>.</p>`
          : `<p class="muted small">O cadastro é feito pelo link de convite que o seu atendente envia.
              ${invite ? '<b>Este convite não é válido.</b>' : ''}</p>`}
        ${group ? googleBlock('Criar conta com o Google') : ''}
        <label>Nome completo<input name="name" autocomplete="name" required maxlength="120"></label>
        <label>E-mail<input name="email" type="email" autocomplete="email" required></label>
        <label>Telefone / WhatsApp <small class="muted">(opcional)</small><input name="phone" type="tel" autocomplete="tel"></label>
        <label>Senha<input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
        <button class="btn primary block" type="submit">Criar conta</button>
        <p class="muted center">Já tem conta? <a href="#/entrar">Entrar</a></p>
      </form>
    </div>`;
  bindGoogle(el, group?.gid);
  const form = el.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    busy(form.querySelector('[type=submit]'), async () => {
      await api.register({ ...formData(form), invite: group?.gid });
      await finish();
    });
  });
}
