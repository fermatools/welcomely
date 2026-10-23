import * as api from '../api.js';
import { go, loadMe, saveRedirect, state } from '../state.js';
import { busy, confirmDialog, empty, esc, formData, icon, modal, spinner, toast } from '../ui.js';

const ROLE_ORDER = ['profissional', 'auxiliar', 'cliente'];
const ROLE_PLURAL = { profissional: 'Atendentes', auxiliar: 'Auxiliares', cliente: 'Clientes' };
const initials = (name) => name.replace(/^(Dra?|Pe|Pr|Sr|Sra)\.\s*/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
const inviteLink = (gid) => `${location.origin}${location.pathname}#/convite/${gid}`;

async function share(title, url) {
  try {
    if (window.WelcomelyAndroid) window.WelcomelyAndroid.share(title, url);
    else if (navigator.share) await navigator.share({ title, url });
    else { await navigator.clipboard.writeText(url); toast('Link copiado.'); }
  } catch (err) {
    if (err.name !== 'AbortError') toast('Copie o link mostrado na tela.');
  }
}

function verificationCard() {
  return `
    <section class="card note">
      <h2>Confirme o seu e-mail</h2>
      <p>A conta de administrador só funciona depois que o e-mail <b>${esc(state.user.email)}</b> for confirmado.
        Abra a mensagem que enviamos e clique no link; depois toque em "Já confirmei".</p>
      <div class="form-foot">
        <button class="btn ghost" id="resend">Reenviar e-mail</button>
        <button class="btn primary" id="verified">Já confirmei</button>
      </div>
    </section>`;
}

// ---------------------------------------------------------------- lista

export async function list(el) {
  el.innerHTML = `<div class="page narrow">${spinner()}</div>`;
  await loadMe();
  const admin = state.user.role === 'admin';
  if (state.needsVerification) {
    el.innerHTML = `<div class="page narrow"><h1>Grupos</h1>${verificationCard()}</div>`;
    el.querySelector('#resend').addEventListener('click', (e) => busy(e.currentTarget, async () => {
      await api.resendVerification();
      toast('E-mail de confirmação reenviado.');
    }));
    el.querySelector('#verified').addEventListener('click', () => list(el));
    return;
  }
  const groups = await api.listGroups();
  el.innerHTML = `
    <div class="page narrow">
      <div class="page-head"><h1>Grupos</h1>
        ${admin ? `<button class="btn primary" id="new">${icon('plus')} Novo grupo</button>` : ''}</div>
      <p class="muted">${admin
        ? 'Cada grupo reúne atendentes, auxiliares e clientes. Um atendente pode estar em vários grupos.'
        : 'Os grupos de que você participa. Abra um grupo para ver os membros e cadastrar pessoas.'}</p>
      <div class="list">${groups.length ? groups.map((g) => `
        <a class="card prof-card" href="#/grupos/${g.gid}">
          <span class="avatar">${icon('users')}</span>
          <span class="prof-info"><b>${esc(g.name)}</b>
            ${admin ? '' : `<small class="muted">Você é ${esc(api.ROLE_NAMES[g.role].toLowerCase())}</small>`}</span>
          ${icon('right', 'chev')}
        </a>`).join('') : empty(admin ? 'Nenhum grupo ainda. Crie o primeiro.' : 'Você ainda não está em nenhum grupo.', 'users')}</div>
    </div>`;
  el.querySelector('#new')?.addEventListener('click', () => modal({
    title: 'Novo grupo',
    submitLabel: 'Criar grupo',
    body: '<label>Nome do grupo<input name="name" required maxlength="120" placeholder="Ex.: Consultório Dra. Ana, Paróquia São José"></label>',
    onSubmit: async (form) => {
      const gid = await api.createGroup(form.elements.name.value);
      toast('Grupo criado.');
      go(`#/grupos/${gid}`);
      return true;
    },
  }));
}

// ---------------------------------------------------------------- detalhe

export async function detail(el, gid) {
  el.innerHTML = `<div class="page narrow">${spinner()}</div>`;
  const g = await api.groupMembers(gid);
  const link = inviteLink(gid);
  const byRole = (r) => g.members.filter((m) => m.role === r);
  el.innerHTML = `
    <div class="page narrow">
      <p><a href="#/grupos">${icon('left')} Grupos</a></p>
      <div class="page-head"><h1>${esc(g.name)}</h1>
        ${g.canAdd.length ? `<button class="btn primary" id="add">${icon('plus')} Cadastrar</button>` : ''}</div>
      <section class="card">
        <h2>Convite para clientes</h2>
        <p class="muted small">Quem abrir este link pode criar uma conta de cliente já dentro deste grupo.</p>
        <div class="share"><input readonly value="${esc(link)}" aria-label="Link de convite">
          <button class="btn" id="share">${icon('share')} Compartilhar</button></div>
      </section>
      ${ROLE_ORDER.map((r) => `
        <h2 class="section-title">${ROLE_PLURAL[r]} (${byRole(r).length})</h2>
        <div class="list">${byRole(r).length ? byRole(r).map((m) => `
          <article class="card person">
            <span class="avatar">${esc(initials(m.name))}</span>
            <div><b>${esc(m.name)}</b><br><small class="muted">${esc(m.email)}${m.phone ? ` · ${esc(m.phone)}` : ''}</small></div>
            ${g.canAdd.includes(m.role) && m.uid !== state.user.id
              ? `<button class="btn small ghost danger" data-rm="${esc(m.uid)}" data-name="${esc(m.name)}">Retirar</button>` : ''}
          </article>`).join('') : '<p class="muted small">Ninguém ainda.</p>'}</div>`).join('')}
    </div>`;

  el.querySelector('#share').addEventListener('click', () => share(`Convite: ${g.name}`, link));
  el.querySelector('#add')?.addEventListener('click', () => addForm(g, () => detail(el, gid)));
  el.querySelector('.page').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (!rm || !await confirmDialog(`Retirar ${rm.dataset.name} do grupo "${g.name}"? A conta continua existindo.`,
      { okLabel: 'Retirar', danger: true })) return;
    busy(rm, async () => {
      await api.removeMember(gid, rm.dataset.rm);
      toast('Pessoa retirada do grupo.');
      detail(el, gid);
    });
  });
}

function addForm(g, onDone) {
  modal({
    title: `Cadastrar em ${g.name}`,
    submitLabel: 'Cadastrar',
    body: `
      <fieldset class="roles">
        <legend>Perfil</legend>
        ${g.canAdd.map((r, i) => `
          <label class="role-card"><input type="radio" name="role" value="${r}"${i === g.canAdd.length - 1 ? ' checked' : ''}>
            ${icon(r === 'cliente' ? 'calendar' : r === 'auxiliar' ? 'users' : 'user')}
            <span><b>${api.ROLE_NAMES[r]}</b></span></label>`).join('')}
      </fieldset>
      <label>E-mail<input name="email" type="email" required autocomplete="off"></label>
      <label>Nome completo<input name="name" maxlength="120" autocomplete="off"></label>
      <label>Telefone / WhatsApp <small class="muted">(opcional)</small><input name="phone" type="tel" autocomplete="off"></label>
      <p class="muted small">Se a pessoa ainda não tiver conta, ela recebe um e-mail para criar a própria senha.
        Se já tiver, só passa a fazer parte do grupo.</p>`,
    onSubmit: async (form) => {
      const res = await api.addMember(g.gid, formData(form));
      toast(res.created
        ? (api.DEMO ? 'Conta criada (na demonstração a senha é demo123).' : 'Conta criada. A pessoa vai receber um e-mail para criar a senha.')
        : 'Pessoa incluída no grupo.');
      onDone();
      return true;
    },
  });
}

// ---------------------------------------------------------------- convite

export async function invite(el, gid) {
  const g = await api.getInvite(gid);
  const already = state.groups.some((x) => x.gid === gid);
  el.innerHTML = `
    <div class="page narrow about">
      <img src="icons/icon.svg" alt="" width="72" height="72">
      <p class="muted">Convite para</p>
      <h1>${esc(g.name)}</h1>
      <section class="card">
        ${!state.user ? `
          <p>Crie sua conta para agendar atendimentos com este grupo.</p>
          <a class="btn primary block" href="#/cadastro/${esc(gid)}">Criar conta</a>
          <p class="muted small center">Já tem conta? <a href="#/entrar" id="login">Entrar</a></p>`
        : already ? `
          <p>Você já faz parte deste grupo.</p>
          <a class="btn primary block" href="#/buscar">Agendar</a>`
        : state.user.role === 'cliente' ? `
          <p>Entre no grupo para agendar com os atendentes dele.</p>
          <button class="btn primary block" id="join">Entrar no grupo</button>`
        : `<p>Este convite é para clientes. Para incluir você como ${esc(api.ROLE_NAMES[state.user.role].toLowerCase())},
            peça a um atendente ou ao administrador do grupo.</p>`}
      </section>
    </div>`;
  el.querySelector('#login')?.addEventListener('click', () => saveRedirect(`#/convite/${gid}`));
  el.querySelector('#join')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api.joinGroup(gid);
    await loadMe();
    toast(`Você entrou em ${g.name}.`);
    go('#/buscar');
  }));
}
