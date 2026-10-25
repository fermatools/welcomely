import * as api from '../api.js';
import { phoneMatches } from '../data/logic.js';
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
        Abra a mensagem que enviamos (se não estiver na caixa de entrada, procure no <b>spam</b>) e clique no
        link; depois toque em "Já confirmei".</p>
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
        ${g.canAdd.length ? `<button class="btn primary" id="add">${icon('plus')} Adicionar pessoa</button>` : ''}</div>
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
            <div><b>${esc(m.name)}</b>${m.no_account ? ' <span class="badge muted">sem conta</span>' : ''}<br>
              <small class="muted">${esc([m.email, m.phone].filter(Boolean).join(' · '))}</small></div>
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
  let picked = null;   // pessoa já cadastrada escolhida na busca
  const m = modal({
    title: `Adicionar a ${g.name}`,
    submitLabel: 'Adicionar',
    body: `
      <div class="field">
        <span class="field-label">Pessoa já cadastrada</span>
        <label class="search small-search">${icon('search')}
          <input id="find" type="search" placeholder="Buscar por nome ou e-mail" autocomplete="off" aria-label="Buscar pessoa"></label>
        <div id="found" class="found"></div>
      </div>
      <div id="picked" class="note-inline" hidden></div>
      <div id="new-person">
        <p class="divider"><span>ou cadastre uma pessoa nova</span></p>
        <fieldset class="roles">
          <legend>Perfil</legend>
          ${g.canAdd.map((r, i) => `
            <label class="role-card"><input type="radio" name="role" value="${r}"${i === g.canAdd.length - 1 ? ' checked' : ''}>
              ${icon(r === 'cliente' ? 'calendar' : r === 'auxiliar' ? 'users' : 'user')}
              <span><b>${api.ROLE_NAMES[r]}</b></span></label>`).join('')}
        </fieldset>
        ${g.canAdd.includes('cliente') ? `<label class="check" id="no-account-row"><input type="checkbox" name="no_account">
          Cliente sem conta: só nome e contato, para agendar pela secretaria (não recebe e-mail nem acessa o app)</label>` : ''}
        <label>E-mail <small class="muted" id="email-hint" hidden>(se não tiver telefone)</small><input name="email" type="email" autocomplete="off"></label>
        <label>Nome completo<input name="name" maxlength="120" autocomplete="off"></label>
        <label>Telefone / WhatsApp <small class="muted" id="phone-hint">(opcional)</small><input name="phone" type="tel" autocomplete="off"></label>
        <p class="muted small" id="account-note">Quem ainda não tem conta recebe um e-mail para criar a própria senha (pode cair no spam).
          Se o e-mail já tiver conta, a pessoa só passa a fazer parte do grupo.</p>
        <p class="muted small" id="contact-note" hidden>Informe o telefone ou o e-mail (pelo menos um).</p>
      </div>`,
    onSubmit: async (form) => {
      const data = picked
        ? { email: picked.email, name: picked.name, phone: picked.phone, role: picked.role, no_account: picked.no_account, cid: picked.no_account ? picked.uid : undefined }
        : formData(form);
      if (!picked && data.role !== 'cliente') data.no_account = false;
      if (!data.no_account && !data.email) {
        toast('Escolha uma pessoa já cadastrada ou informe o e-mail da pessoa nova.', 'error');
        return false;
      }
      if (data.no_account && !data.email && !data.phone) {
        toast('Informe o telefone ou o e-mail do cliente.', 'error');
        return false;
      }
      const res = await api.addMember(g.gid, data);
      toast(res.contact ? `${data.name} (sem conta) agora faz parte de ${g.name}.` : res.created
        ? (api.DEMO ? 'Conta criada (na demonstração a senha é demo123).' : 'Conta criada. A pessoa vai receber um e-mail para criar a senha (avise para olhar também o spam).')
        : `${data.name || 'A pessoa'} agora faz parte de ${g.name}.`);
      onDone();
      return true;
    },
  });

  const form = m.form;
  const found = form.querySelector('#found');
  const pickedEl = form.querySelector('#picked');
  const newPerson = form.querySelector('#new-person');
  let people = null;
  const fold = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const show = async () => {
    const q = fold(form.querySelector('#find').value.trim());
    if (people === null) {
      found.innerHTML = spinner();
      try { people = await api.knownPeople(g.gid); } catch (err) { found.innerHTML = `<p class="error-text">${esc(err.message)}</p>`; return; }
    }
    const list = people.filter((p) => fold(`${p.name} ${p.email}`).includes(q) || phoneMatches(p.phone, q)).slice(0, 8);
    found.innerHTML = list.length ? list.map((p, i) => `
      <button type="button" class="found-item" data-i="${people.indexOf(p)}">
        <b>${esc(p.name)}</b> <span class="badge info">${esc(api.ROLE_NAMES[p.role])}</span>${p.no_account ? ' <span class="badge muted">sem conta</span>' : ''}<br>
        <small class="muted">${esc([p.email, p.phone].filter(Boolean).join(' · '))}</small></button>`).join('')
      : `<p class="muted small">${people.length ? 'Ninguém encontrado com esse nome.' : 'Não há outras pessoas cadastradas que você possa adicionar.'}</p>`;
  };
  const choose = (p) => {
    picked = p;
    pickedEl.hidden = !p;
    newPerson.hidden = Boolean(p);
    found.hidden = Boolean(p);
    if (p) {
      pickedEl.innerHTML = `${icon('user')} <span><b>${esc(p.name)}</b> · ${esc(api.ROLE_NAMES[p.role])}${p.no_account ? ' (sem conta)' : ''}<br>
        <small class="muted">${esc([p.email, p.phone].filter(Boolean).join(' · '))}</small></span>
        <button type="button" class="btn small ghost" id="unpick">Trocar</button>`;
      pickedEl.querySelector('#unpick').addEventListener('click', () => choose(null));
    }
  };
  const syncNoAccount = () => {
    const role = form.querySelector('[name=role]:checked')?.value;
    const row = form.querySelector('#no-account-row');
    if (row) row.hidden = role !== 'cliente';
    const contact = role === 'cliente' && form.elements.no_account?.checked;
    form.querySelector('#email-hint').hidden = !contact;
    form.querySelector('#phone-hint').textContent = contact ? '(se não tiver e-mail)' : '(opcional)';
    form.querySelector('#account-note').hidden = contact;
    form.querySelector('#contact-note').hidden = !contact;
  };
  form.addEventListener('change', (e) => { if (['role', 'no_account'].includes(e.target.name)) syncNoAccount(); });
  syncNoAccount();
  let timer;
  form.querySelector('#find').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 200); });
  form.querySelector('#find').addEventListener('focus', () => { if (people === null) show(); });
  found.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) choose(people[Number(b.dataset.i)]);
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
