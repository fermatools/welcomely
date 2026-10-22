import * as api from '../api.js';
import { go, homeFor, loadMe, state, takeRedirect } from '../state.js';
import { busy, esc, formData, icon, toast } from '../ui.js';

const ROLE_CARDS = [
  ['cliente', 'Quero agendar', 'Marcar atendimentos com profissionais', 'calendar'],
  ['profissional', 'Eu atendo', 'Profissional liberal, sacerdote, consultor…', 'user'],
  ['auxiliar', 'Sou auxiliar', 'Secretária ou assistente de quem atende', 'users'],
];

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
        <label>E-mail<input name="email" type="email" autocomplete="email" required></label>
        <label>Senha<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary block" type="submit">Entrar</button>
        <p class="center"><button type="button" class="link muted small" id="forgot">Esqueci minha senha</button></p>
        <p class="muted center">Ainda não tem conta? <a href="#/cadastro">Cadastre-se</a></p>
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
  el.querySelector('#forgot').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api.resetPassword(form.elements.email.value);
    toast('Enviamos um e-mail com o link para criar uma nova senha.');
  }));
  el.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    const { DEMO_PASSWORD } = await import('../data/store-demo.js');
    await api.login({ email: b.dataset.demo, password: DEMO_PASSWORD });
    await finish();
  })));
}

export function register(el) {
  el.innerHTML = `
    <div class="auth">
      ${hero()}
      <form class="card auth-card" novalidate>
        <h2>Criar conta</h2>
        <fieldset class="roles">
          <legend>Como você vai usar o Welcomely?</legend>
          ${ROLE_CARDS.map(([value, title, desc, ic], i) => `
            <label class="role-card">
              <input type="radio" name="role" value="${value}" ${i === 0 ? 'checked' : ''}>
              ${icon(ic)}<span><b>${title}</b><small>${desc}</small></span>
            </label>`).join('')}
        </fieldset>
        <label>Nome completo<input name="name" autocomplete="name" required maxlength="120"></label>
        <label>E-mail<input name="email" type="email" autocomplete="email" required></label>
        <label>Telefone / WhatsApp <small class="muted">(opcional)</small><input name="phone" type="tel" autocomplete="tel"></label>
        <label>Senha<input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
        <button class="btn primary block" type="submit">Criar conta</button>
        <p class="muted center">Já tem conta? <a href="#/entrar">Entrar</a></p>
      </form>
    </div>`;
  const form = el.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    busy(form.querySelector('[type=submit]'), async () => {
      await api.register(formData(form));
      await finish();
    });
  });
}
