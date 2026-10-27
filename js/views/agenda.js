import * as api from '../api.js';
import { addToCalendar, downloadIcs, eventFor } from '../calendar.js';
import { blockIntervals, hhmm, whatsappDigits } from '../data/logic.js';
import { notifyClient } from '../notify.js';
import { currentPid, setPid, state } from '../state.js';
import {
  addDays, busy, confirmDialog, empty, esc, fmtDay, fmtDuration, formData, icon, modal, parseDate, spinner,
  statusBadge, timeOf, toast, today, weekdayIndex,
} from '../ui.js';

// Estado da tela (mantido ao trocar de aba)
const view = { date: today(), mode: 'dia', showCancelled: false, serviceByPid: {} };

// ------------------------------------------------- seletor de atendente

export function profPicker(pid) {
  if (state.manages.length < 2) return '';
  return `<label class="picker" title="Atendente">${icon('user')}
    <select id="pid" aria-label="Atendente">${state.manages.map((p) => `
      <option value="${p.id}"${p.id === pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`;
}

export function bindPicker(el, rerender) {
  el.querySelector('#pid')?.addEventListener('change', (e) => { setPid(e.target.value); rerender(); });
}

// Auxiliar ainda sem vínculo com nenhum atendente
export function noProfessional(el) {
  el.innerHTML = `<div class="page narrow">${empty('Ainda não há agendas para você gerenciar.', 'users')}
    <div class="card note">${state.user.role === 'admin'
      ? 'Cadastre atendentes em <a href="#/grupos">Grupos</a>.'
      : `Você passa a gerenciar a agenda dos atendentes dos grupos em que for incluído. Peça a um atendente ou ao
        administrador para cadastrar o seu e-mail (<b>${esc(state.user.email)}</b>) num grupo.`}</div></div>`;
}

// ---------------------------------------------------------------- cartões

const whatsapp = (phone) => {
  const n = whatsappDigits(phone);
  return n ? `https://wa.me/${n}` : '';
};

function actionsFor(a, contacts) {
  const btn = (act, label, cls = 'ghost') => `<button class="btn small ${cls}" data-act="${act}" data-id="${a.id}">${label}</button>`;
  const list = [];
  if (a.status === 'pendente') list.push(btn('confirmado', `${icon('check')} Confirmar`, 'primary'), btn('cancelado', 'Recusar', 'ghost danger'));
  if (a.status === 'confirmado') {
    list.push(btn('concluido', 'Concluído'), btn('faltou', 'Faltou'), btn('remarcar', 'Remarcar'));
    if (contacts) list.push(btn('avisar', 'Avisar'));
    list.push(btn('cancelado', 'Cancelar', 'ghost danger'));
  }
  if (['concluido', 'faltou'].includes(a.status)) list.push(btn('confirmado', 'Desfazer'));
  if (['pendente', 'confirmado'].includes(a.status)) list.push(btn('agenda', `${icon('calendar')} Agenda`));
  if (a.status !== 'cancelado') list.push(btn('nota', `${icon('note')} Anotação`));
  return list.join('');
}

function apptCard(a, { withDate = false, contacts = true } = {}) {
  const wa = contacts && a.client_phone ? whatsapp(a.client_phone) : '';
  return `
    <article class="card appt ${a.status}">
      <div class="appt-when">${withDate ? `<small class="when-day">${esc(fmtDay(a.starts_at, { weekday: 'short', day: 'numeric', month: 'short' }))}</small>` : ''}
        <b>${timeOf(a.starts_at)}</b><small>${timeOf(a.ends_at)}</small></div>
      <div class="appt-main">
        <div class="appt-top"><b>${esc(a.client_name)}</b>${statusBadge(a.status, true)}</div>
        <div>${esc(a.service_name)}</div>
        ${contacts && (a.client_phone || a.client_email) ? `<small class="contact">
          ${a.client_phone ? `<a href="tel:${esc(a.client_phone)}">${icon('phone')} ${esc(a.client_phone)}</a>` : ''}
          ${wa ? `<a href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          ${a.client_email ? `<a href="mailto:${esc(a.client_email)}">${esc(a.client_email)}</a>` : ''}</small>` : ''}
        ${a.notes ? `<small class="appt-notes">${icon('note')} ${esc(a.notes)}</small>` : ''}
      </div>
      <div class="appt-actions">${actionsFor(a, contacts)}</div>
    </article>`;
}

function rangeTitle(from, to) {
  if (from === to) return fmtDay(from);
  const a = parseDate(from);
  const b = parseDate(to);
  const month = (d) => d.toLocaleDateString('pt-BR', { month: 'long' });
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()} a ${b.getDate()} de ${month(b)}`
    : `${a.getDate()} de ${month(a)} a ${b.getDate()} de ${month(b)}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- agenda

export async function agenda(el) {
  const pid = currentPid();
  if (!pid) return noProfessional(el);
  const contacts = api.canSeeContacts(pid);
  const from = view.mode === 'dia' ? view.date : addDays(view.date, -weekdayIndex(view.date));
  const to = view.mode === 'dia' ? from : addDays(from, 6);
  const step = view.mode === 'dia' ? 1 : 7;

  el.innerHTML = `
    <div class="page wide">
      <div class="page-head"><h1>Agenda</h1>
        <button class="btn primary" id="new">${icon('plus')} Agendar</button></div>
      ${profPicker(pid) ? `<div class="toolbar">${profPicker(pid)}</div>` : ''}
      <div class="toolbar">
        <div class="date-nav">
          <button class="icon-btn" data-move="-1" aria-label="Anterior">${icon('left')}</button>
          <button class="btn small ghost" data-move="0">Hoje</button>
          <button class="icon-btn" data-move="1" aria-label="Próximo">${icon('right')}</button>
          <input type="date" id="goto" value="${view.date}" aria-label="Ir para a data">
        </div>
        <div class="seg" role="group" aria-label="Visualização">
          <button data-mode="dia" class="${view.mode === 'dia' ? 'active' : ''}">Dia</button>
          <button data-mode="semana" class="${view.mode === 'semana' ? 'active' : ''}">Semana</button>
        </div>
      </div>
      <div class="quick-links">
        <a class="btn small ghost" href="#/horarios">${icon('clock')} Horários de atendimento</a>
        <a class="btn small ghost" href="#/servicos">${icon('list')} Serviços</a>
      </div>
      <div id="pending"></div>
      <h2 class="range-title">${rangeTitle(from, to)}</h2>
      <div id="summary" class="day-summary"></div>
      <div id="service-row"></div>
      <div id="list">${spinner()}</div>
      <div class="agenda-foot">
        <label class="check"><input type="checkbox" id="show-cancelled"${view.showCancelled ? ' checked' : ''}> Mostrar cancelados</label>
        ${window.WelcomelyAndroid ? '' : `<button class="btn small ghost" id="export" title="Baixar os atendimentos para o Google Agenda, Apple, Outlook">
          ${icon('calendar')} Exportar (.ics)</button>`}
      </div>
    </div>`;

  const rerender = () => agenda(el);
  bindPicker(el, rerender);
  const page = el.querySelector('.page');
  page.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { view.mode = b.dataset.mode; rerender(); }));
  page.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.move);
    view.date = n === 0 ? today() : addDays(view.date, n * step);
    rerender();
  }));
  page.querySelector('#goto').addEventListener('change', (e) => { if (e.target.value) { view.date = e.target.value; rerender(); } });
  page.querySelector('#show-cancelled').addEventListener('change', (e) => { view.showCancelled = e.target.checked; rerender(); });
  page.querySelector('#new').addEventListener('click', () => appointmentForm(pid, null, rerender));

  let loaded = [];
  page.addEventListener('click', async (e) => {
    const free = e.target.closest('[data-free]');
    if (free) {
      appointmentForm(pid, null, rerender, { date: free.dataset.day, time: free.dataset.free, serviceId: view.serviceByPid[pid] });
      return undefined;
    }
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) {
      view.date = dayBtn.dataset.day;
      view.mode = 'dia';
      rerender();
      return undefined;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return undefined;
    const appt = loaded.find((a) => a.id === b.dataset.id);
    const act = b.dataset.act;
    if (act === 'remarcar') return appointmentForm(pid, appt, rerender);
    if (act === 'avisar') return notifyClient(appt, 'confirmado');
    if (act === 'nota') return noteForm(appt, rerender);
    if (act === 'agenda') return addToCalendar(eventFor(appt, false));
    if (act === 'cancelado' && !await confirmDialog(
      `${appt.status === 'pendente' ? 'Recusar' : 'Cancelar'} o atendimento de ${appt.client_name}?`,
      { okLabel: appt.status === 'pendente' ? 'Recusar' : 'Cancelar atendimento', danger: true })) return undefined;
    return busy(b, async () => {
      // o agendamento salvo não traz telefone/e-mail (ficam à parte): reaproveita os que já estão na tela
      const updated = { ...await api.updateAppointment(appt.id, { status: act }), client_phone: appt.client_phone, client_email: appt.client_email };
      toast('Agendamento atualizado.');
      rerender();
      // Ao confirmar um pedido ou cancelar, oferece avisar o cliente
      if (contacts && act === 'confirmado' && appt.status === 'pendente') notifyClient(updated, 'confirmado');
      if (contacts && act === 'cancelado') notifyClient(updated, 'cancelado');
    });
  });

  // Serviço usado para calcular os horários livres (a duração muda o que cabe)
  const services = (await api.listServices(pid)).filter((s) => s.active);
  if (!services.some((s) => s.id === view.serviceByPid[pid])) view.serviceByPid[pid] = services[0]?.id;
  const sid = view.serviceByPid[pid];

  const [appointments, pending, free] = await Promise.all([
    api.agenda(pid, from, to), api.pending(pid),
    sid ? api.freeSlotsRange(pid, sid, from, to) : Promise.resolve({ slots: {}, blocks: [] })]);
  loaded = [...appointments, ...pending];

  page.querySelector('#export')?.addEventListener('click', () => {
    const active = appointments.filter((a) => ['pendente', 'confirmado'].includes(a.status));
    if (!active.length) { toast('Não há atendimentos neste período.', 'error'); return; }
    downloadIcs(active.map((a) => eventFor(a, false)), `welcomely-${from}${to !== from ? `-a-${to}` : ''}.ics`);
  });

  if (pending.length) {
    page.querySelector('#pending').innerHTML = `
      <section class="pending-box">
        <h2 class="section-title">${icon('clock')} Aguardando confirmação (${pending.length})</h2>
        <div class="list">${pending.map((a) => apptCard(a, { withDate: true, contacts })).join('')}</div>
      </section>`;
  }

  page.querySelector('#service-row').innerHTML = services.length > 1 ? `
    <label class="inline-select">Horários livres para
      <select id="free-service">${services.map((s) => `
        <option value="${s.id}"${s.id === sid ? ' selected' : ''}>${esc(s.name)} (${fmtDuration(s.duration_min)})</option>`).join('')}</select></label>` : '';
  page.querySelector('#free-service')?.addEventListener('change', (e) => { view.serviceByPid[pid] = e.target.value; rerender(); });

  const isActive = (a) => a.status !== 'cancelado';
  const visible = appointments.filter((a) => view.showCancelled || isActive(a));
  const days = Array.from({ length: step }, (_, i) => addDays(from, i));
  const list = page.querySelector('#list');
  const marked = appointments.filter(isActive).length;
  const freeCount = days.reduce((n, d) => n + (free.slots[d]?.length || 0), 0);
  page.querySelector('#summary').innerHTML = `
    <span class="pill ok-pill">${plural(marked, 'marcado', 'marcados')}</span>
    <span class="pill free-pill">${plural(freeCount, 'horário livre', 'horários livres')}</span>
    ${!services.length ? '<span class="muted small">Cadastre um serviço para ver os horários livres.</span>' : ''}`;

  if (view.mode === 'dia') {
    list.innerHTML = dayTimeline(from, visible, free.slots[from] || [], free.blocks, contacts);
  } else {
    list.innerHTML = `<div class="week-overview">${days.map((d) => weekRow(d, visible, free.slots[d] || [])).join('')}</div>`;
  }
  return undefined;
}

/** Linha do tempo do dia: atendimentos, horários livres (toque para agendar) e bloqueios, em ordem. */
function dayTimeline(day, appts, freeSlots, blocks, contacts) {
  const items = [
    ...appts.map((a) => ({ t: a.start, html: apptCard(a, { contacts }) })),
    ...freeSlots.map((t) => ({
      t, html: `<button class="free-slot" data-free="${t}" data-day="${day}">
        <b>${t}</b><span>Livre</span><span class="free-add">${icon('plus')} Agendar</span></button>` })),
    ...blockIntervals(blocks, day).map(([s, e]) => {
      const b = blocks.find((x) => x.starts_at <= `${day}T${hhmm(s)}` || x.starts_at.slice(0, 10) < day);
      return { t: hhmm(s), html: `<div class="blocked-row"><b>${hhmm(s)}–${e >= 1440 ? '24:00' : hhmm(e)}</b>
        <span>Bloqueado${b?.reason ? ` · ${esc(b.reason)}` : ''}</span></div>` };
    }),
  ].sort((x, y) => x.t.localeCompare(y.t));
  if (!items.length) {
    return `${empty('Sem atendimentos nem horários livres neste dia.')}
      <p class="center"><a class="btn small" href="#/horarios">${icon('clock')} Definir horários de atendimento</a></p>`;
  }
  return `<div class="list timeline">${items.map((i) => i.html).join('')}</div>`;
}

/** Uma linha do panorama da semana: barra de ocupação e primeiros nomes. */
function weekRow(day, appts, freeSlots) {
  const items = appts.filter((a) => a.day === day);
  const marked = items.filter((a) => a.status !== 'cancelado');
  const total = marked.length + freeSlots.length;
  const pct = total ? Math.round((marked.length / total) * 100) : 0;
  return `
    <button class="card week-row${day === today() ? ' today' : ''}" data-day="${day}">
      <div class="week-row-head"><b>${esc(fmtDay(day, { weekday: 'short', day: 'numeric', month: 'short' }))}</b>
        <small class="muted">${total ? `${plural(marked.length, 'marcado', 'marcados')} · ${plural(freeSlots.length, 'livre', 'livres')}` : 'sem atendimento'}</small></div>
      ${total ? `<div class="occupancy" aria-hidden="true"><span style="width:${pct}%"></span></div>` : ''}
      ${marked.length ? `<small class="week-names">${marked.slice(0, 4).map((a) => `${a.start} ${esc(a.client_name.split(' ')[0])}`).join(' · ')}${marked.length > 4 ? ' …' : ''}</small>` : ''}
    </button>`;
}

// ------------------------------------------------ novo agendamento / remarcar

async function appointmentForm(pid, appt, onDone, preset = {}) {
  const services = (await api.listServices(pid)).filter((s) => s.active);
  if (!services.length) {
    toast('Cadastre um serviço antes de agendar.', 'error');
    return;
  }
  const reschedule = Boolean(appt);
  const contacts = api.canSeeContacts(pid);
  const [clients, groups] = reschedule ? [[], []]
    : await Promise.all([api.clientSuggestions(pid, ''), contacts ? api.bookingGroups(pid) : Promise.resolve([])]);
  const startDate = preset.date || (reschedule ? appt.starts_at.slice(0, 10) : view.date < today() ? today() : view.date);
  const sid0 = preset.serviceId && services.some((s) => s.id === preset.serviceId) ? preset.serviceId : services[0].id;

  const m = modal({
    title: reschedule ? `Remarcar — ${appt.client_name}` : 'Novo agendamento',
    submitLabel: reschedule ? 'Remarcar' : 'Agendar',
    body: `
      ${reschedule ? `<p class="muted">${esc(appt.service_name)} · atual: ${esc(fmtDay(appt.starts_at))} às ${timeOf(appt.starts_at)}</p>` : `
      <div class="field">
        <span class="field-label">Cliente</span>
        <div id="chosen" class="note-inline" hidden></div>
        <div id="client-pick">
          <label class="search small-search">${icon('search')}
            <input id="client-q" type="search" placeholder="Buscar cliente cadastrado" autocomplete="off" aria-label="Buscar cliente"></label>
          <div id="client-list" class="found"></div>
          ${groups.length ? `<button type="button" class="btn small ghost" id="new-client">${icon('plus')} Novo cliente</button>` : ''}
        </div>
        <div id="new-client-fields" hidden>
          <label>Nome do cliente<input name="client_name" maxlength="120" autocomplete="off"></label>
          <div class="row">
            <label>Telefone<input name="client_phone" type="tel" autocomplete="off"></label>
            <label>E-mail<input name="client_email" type="email" autocomplete="off"></label>
          </div>
          ${groups.length > 1 ? `<label>Cadastrar no grupo<select name="client_group">${groups.map((g) => `
            <option value="${g.gid}">${esc(g.name)}</option>`).join('')}</select></label>` : ''}
          <label class="check"><input type="checkbox" name="save_client" checked> Salvar este cliente no grupo${groups.length === 1 ? ` (${esc(groups[0].name)})` : ''}</label>
          <button type="button" class="btn small ghost" id="back-to-list">Escolher da lista</button>
        </div>
      </div>
      <label>Serviço<select name="service_id">${services.map((s) => `
        <option value="${s.id}"${s.id === sid0 ? ' selected' : ''}>${esc(s.name)} (${fmtDuration(s.duration_min)})</option>`).join('')}</select></label>`}
      <label>Data<input name="date" type="date" required value="${startDate}"></label>
      <div class="field">
        <span class="field-label">Horário</span>
        <div class="slots compact" id="f-slots"></div>
        <label class="check"><input type="checkbox" name="fit_in"> Encaixe (horário fora da grade)</label>
        <input name="time_free" type="time" hidden>
      </div>
      ${reschedule ? '' : '<label>Observações<textarea name="notes" rows="2" maxlength="1000"></textarea></label>'}`,
    onSubmit: async (form) => {
      const data = formData(form);
      const time = data.fit_in ? data.time_free : chosen;
      if (!time) {
        toast('Escolha um horário.', 'error');
        return false;
      }
      if (reschedule) {
        const updated = { ...await api.updateAppointment(appt.id, { date: data.date, time }), client_phone: appt.client_phone, client_email: appt.client_email };
        toast('Atendimento remarcado.');
        if (contacts) setTimeout(() => notifyClient(updated, 'remarcado'), 50);
        onDone();
        return true;
      }
      const body = { professional_id: pid, service_id: data.service_id, date: data.date, time, fit_in: data.fit_in, notes: data.notes };
      if (picked) {
        body.client_ref = picked.ref;
      } else if (creating) {
        const name = (data.client_name || '').trim();
        if (!name) { toast('Informe o nome do cliente.', 'error'); return false; }
        if (data.save_client && !data.client_phone && !data.client_email) {
          toast('Para salvar o cliente no grupo, informe o telefone ou o e-mail.', 'error');
          return false;
        }
        Object.assign(body, { client_name: name, client_phone: data.client_phone, client_email: data.client_email });
        if (data.save_client) {
          const gid = data.client_group || groups[0].gid;
          try {
            await api.addMember(gid, { name, phone: data.client_phone, email: data.client_email, role: 'cliente', no_account: true });
          } catch (err) {
            if (!/já está no grupo/.test(err.message)) throw err;   // já cadastrado: só agenda
          }
        }
      } else {
        toast('Escolha um cliente da lista ou cadastre um novo.', 'error');
        return false;
      }
      const created = await api.createAppointment(body);
      toast('Atendimento agendado.');
      if (contacts) setTimeout(() => notifyClient(created, 'confirmado'), 50);
      onDone();
      return true;
    },
  });

  const form = m.form;
  const slotsEl = form.querySelector('#f-slots');
  const freeInput = form.elements.time_free;
  let chosen = preset.time || null;
  let picked = null;
  let creating = false;
  let seq = 0;
  const serviceId = () => (reschedule ? appt.service_id : form.elements.service_id.value);
  const loadSlots = async () => {
    const mine = ++seq;
    slotsEl.innerHTML = spinner();
    try {
      const slots = await api.slots(pid, serviceId(), form.elements.date.value);
      if (mine !== seq) return;
      if (!slots.includes(chosen)) chosen = null;
      slotsEl.innerHTML = slots.length
        ? slots.map((t) => `<button type="button" class="slot${t === chosen ? ' active' : ''}" data-time="${t}">${t}</button>`).join('')
        : '<p class="muted small">Sem horários livres na grade. Use "Encaixe" para outro horário.</p>';
    } catch (err) { slotsEl.innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
  };
  slotsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-time]');
    if (!b) return;
    chosen = b.dataset.time;
    slotsEl.querySelectorAll('.slot').forEach((s) => s.classList.toggle('active', s === b));
  });
  form.elements.fit_in.addEventListener('change', (e) => {
    freeInput.hidden = !e.target.checked;
    freeInput.required = e.target.checked;
    slotsEl.hidden = e.target.checked;
  });
  form.elements.date.addEventListener('change', loadSlots);

  if (!reschedule) {
    form.elements.service_id.addEventListener('change', loadSlots);
    const pick = form.querySelector('#client-pick');
    const listEl = form.querySelector('#client-list');
    const chosenEl = form.querySelector('#chosen');
    const fields = form.querySelector('#new-client-fields');
    const fold = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const renderList = () => {
      const q = fold(form.querySelector('#client-q').value.trim());
      const qDigits = q.replace(/\D/g, '');
      const hits = clients.filter((c) => !q || fold(c.name).includes(q) || fold(c.email).includes(q)
        || (qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits))).slice(0, 12);
      listEl.innerHTML = hits.length ? hits.map((c) => `
        <button type="button" class="found-item" data-ref="${esc(c.ref)}">
          <b>${esc(c.name)}</b>${c.group ? ` <span class="badge muted">${esc(c.group)}</span>` : ''}
          ${contacts && (c.phone || c.email) ? `<br><small class="muted">${esc([c.phone, c.email].filter(Boolean).join(' · '))}</small>` : ''}
        </button>`).join('')
        : `<p class="muted small">${clients.length ? 'Nenhum cliente com esse nome.' : 'Ainda não há clientes cadastrados.'}
          ${groups.length ? ' Use "Novo cliente".' : ''}</p>`;
    };
    const choose = (c) => {
      picked = c;
      creating = false;
      chosenEl.hidden = !c;
      pick.hidden = Boolean(c);
      fields.hidden = true;
      if (c) {
        chosenEl.innerHTML = `${icon('user')} <span><b>${esc(c.name)}</b>${contacts && (c.phone || c.email)
          ? `<br><small class="muted">${esc([c.phone, c.email].filter(Boolean).join(' · '))}</small>` : ''}</span>
          <button type="button" class="btn small ghost" id="change-client">Trocar</button>`;
        chosenEl.querySelector('#change-client').addEventListener('click', () => choose(null));
      }
    };
    const startNew = () => {
      picked = null;
      creating = true;
      pick.hidden = true;
      chosenEl.hidden = true;
      fields.hidden = false;
      const typed = form.querySelector('#client-q').value.trim();
      if (typed && !/^[\d\s()+-]+$/.test(typed)) form.elements.client_name.value = typed;
      form.elements.client_name.focus();
    };
    form.querySelector('#client-q').addEventListener('input', renderList);
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ref]');
      if (b) choose(clients.find((c) => c.ref === b.dataset.ref));
    });
    form.querySelector('#new-client')?.addEventListener('click', startNew);
    form.querySelector('#back-to-list').addEventListener('click', () => { creating = false; fields.hidden = true; pick.hidden = false; });
    renderList();
  }
  loadSlots();
}

function noteForm(appt, onDone) {
  modal({
    title: `Anotação — ${appt.client_name}`,
    submitLabel: 'Salvar',
    body: `<label>Anotação<textarea name="notes" rows="4" maxlength="1000">${esc(appt.notes)}</textarea></label>`,
    onSubmit: async (form) => {
      await api.updateAppointment(appt.id, { notes: form.elements.notes.value });
      toast('Anotação salva.');
      onDone();
      return true;
    },
  });
}
