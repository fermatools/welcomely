import * as api from '../api.js';
import { APP_VERSION, DEVELOPER } from '../config.js';
import { clearSession, go, loadMe, state } from '../state.js';
import { busy, esc, formData, icon, toast } from '../ui.js';


function profileSection(p) {
  return `
    <form class="card" id="profile">
      <h2>Perfil público</h2>
      <p class="muted small">É o que os clientes veem ao agendar com você.</p>
      <label>Título / especialidade<input name="title" maxlength="120" value="${esc(p.title)}" placeholder="Ex.: Psicóloga, Pároco, Advogado"></label>
      <label>Local de atendimento<input name="location" maxlength="200" value="${esc(p.location)}" placeholder="Endereço, sala ou &quot;online&quot;"></label>
      <label>Apresentação<textarea name="bio" rows="3" maxlength="2000">${esc(p.bio)}</textarea></label>
      <h3>Regras de agendamento</h3>
      <label class="check"><input type="checkbox" name="requires_confirmation"${p.requires_confirmation ? ' checked' : ''}>
        Confirmar cada pedido antes de valer (senão, o agendamento é confirmado na hora)</label>
      <div class="row">
        <label>Antecedência mínima (horas)<input name="min_notice_hours" type="number" min="0" max="720" value="${p.min_notice_hours}"></label>
        <label>Agendar até (dias à frente)<input name="max_days_ahead" type="number" min="1" max="365" value="${p.max_days_ahead}"></label>
      </div>
      <div class="row">
        <label>Cancelamento pelo cliente até (horas antes)<input name="cancel_notice_hours" type="number" min="0" max="720" value="${p.cancel_notice_hours}"></label>
        <label>Intervalo entre horários (min)<input name="slot_interval_min" type="number" min="5" max="240" step="5" value="${p.slot_interval_min}"></label>
      </div>
      <div class="form-foot"><button class="btn primary" type="submit">Salvar perfil</button></div>
    </form>`;
}

export async function account(el) {
  await loadMe();
  const u = state.user;
  el.innerHTML = `
    <div class="page narrow">
      <h1>Conta</h1>
      <p class="muted">${esc(u.email)} · <span class="badge info">${api.ROLE_NAMES[u.role]}</span></p>
      ${u.role === 'profissional' ? profileSection(state.profile) : ''}
      ${u.role !== 'admin' ? `<section class="card"><h2>Seus grupos</h2>
        ${state.groups.length ? `<ul class="plain">${state.groups.map((g) => `<li><b>${esc(g.name)}</b></li>`).join('')}</ul>`
          : '<p class="muted small">Nenhum ainda. Peça o link de convite ao seu atendente.</p>'}</section>` : ''}
      <form class="card" id="me">
        <h2>Dados pessoais</h2>
        <label>Nome<input name="name" required maxlength="120" value="${esc(u.name)}"></label>
        <label>Telefone / WhatsApp<input name="phone" type="tel" value="${esc(u.phone)}"></label>
        <details>
          <summary>Trocar senha</summary>
          <label>Senha atual<input name="current_password" type="password" autocomplete="current-password"></label>
          <label>Nova senha<input name="new_password" type="password" minlength="6" autocomplete="new-password"></label>
        </details>
        <div class="form-foot"><button class="btn primary" type="submit">Salvar</button></div>
      </form>
      ${api.DEMO ? `<section class="card"><h2>Demonstração</h2>
        <p class="muted small">Os dados de exemplo ficam só neste navegador.</p>
        <button class="btn ghost danger" id="demo-reset">Restaurar dados de exemplo</button></section>` : ''}
      <div class="account-links">
        <a class="btn ghost" href="#/sobre">${icon('info')} Sobre o Welcomely</a>
        <button class="btn ghost danger" id="logout">${icon('logout')} Sair</button>
      </div>
    </div>`;

  const me = el.querySelector('#me');
  me.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!me.reportValidity()) return;
    busy(me.querySelector('[type=submit]'), async () => {
      await api.updateMe(formData(me));
      me.elements.current_password.value = '';
      me.elements.new_password.value = '';
      await loadMe();
      toast('Dados salvos.');
    });
  });

  const profile = el.querySelector('#profile');
  profile?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!profile.reportValidity()) return;
    busy(profile.querySelector('[type=submit]'), async () => {
      await api.updateProfile(u.id, formData(profile));
      toast('Perfil salvo.');
    });
  });

  el.querySelector('#demo-reset')?.addEventListener('click', async () => {
    api.store.reset();
    await clearSession();
    location.reload();
  });

  el.querySelector('#logout').addEventListener('click', async () => {
    await clearSession();
    go('#/entrar');
  });
}

export function about(el) {
  el.innerHTML = `
    <div class="page narrow about">
      <img src="icons/icon.svg" alt="" width="88" height="88">
      <h1>Welcomely</h1>
      <p class="muted">Versão ${APP_VERSION}</p>
      <p>Agendamento de atendimentos para quem atende — profissionais liberais, sacerdotes, consultores —,
        para suas secretárias e para os clientes.</p>
      <section class="card">
        <p>Desenvolvido por <b>${esc(DEVELOPER.name)}</b></p>
        <p><a href="mailto:${DEVELOPER.email}">${DEVELOPER.email}</a><br>
          <a href="${DEVELOPER.site}" target="_blank" rel="noopener">${DEVELOPER.site.replace(/^https:\/\/|\/$/g, '')}</a></p>
      </section>
      ${api.DEMO ? `<section class="card note"><h2>Modo demonstração</h2>
        <p>Esta cópia do Welcomely funciona sem servidor: as contas e os agendamentos ficam guardados só neste
          navegador, para você conhecer o app. Na tela de entrada há contas de exemplo (senha <b>demo123</b>).</p></section>` : ''}
      ${window.WelcomelyAndroid ? `<p><button class="btn ghost" id="server">Endereço do servidor</button><br>
        <small class="muted">${esc(window.WelcomelyAndroid.serverUrl())}</small></p>` : ''}
      <p><a href="${state.user ? '#/conta' : '#/entrar'}">${icon('left')} Voltar</a></p>
    </div>`;
  el.querySelector('#server')?.addEventListener('click', () => window.WelcomelyAndroid.configureServer());
}
