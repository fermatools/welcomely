import * as api from '../api.js';
import { currentPid, setPid, state } from '../state.js';
import {
  addDays, busy, confirmDialog, empty, esc, fmtDay, fmtDuration, formData, icon, modal, parseDate, spinner,
  statusBadge, timeOf, toast, today, weekdayIndex,
} from '../ui.js';

// Estado da tela (mantido ao trocar de aba)
const view = { date: today(), mode: 'dia', showCancelled: false };

// ------------------------------------------------- seletor de profissional

export function profPicker(pid) {
  if (state.manages.length < 2) return '';
  return `<label class="picker" title="Profissional">${icon('user')}
    <select id="pid" aria-label="Profissional">${state.manages.map((p) => `
      <option value="${p.id}"${p.id === pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`;
}

export function bindPicker(el, rerender) {
  el.querySelector('#pid')?.addEventListener('change', (e) => { setPid(e.target.value); rerender(); });
}

// Auxiliar ainda sem vínculo com nenhum profissional
export function noProfessional(el) {
  el.innerHTML = `<div class="page narrow">${empty('Você ainda não está vinculado a nenhum profissional.', 'users')}
    <div class="card note">Peça ao profissional para abrir <b>Equipe</b> no Welcomely e adicionar o seu e-mail:
      <b>${esc(state.user.email)}</b>. Depois, recarregue esta página.</div></div>`;
}

// ---------------------------------------------------------------- agenda

const whatsapp = (phone) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '';
  return `https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}`;
};

function actionsFor(a) {
  const btn = (act, label, cls = 'ghost') => `<button class="btn small ${cls}" data-act="${act}" data-id="${a.id}">${label}</button>`;
  const list = [];
  if (a.status === 'pendente') list.push(btn('confirmado', `${icon('check')} Confirmar`, 'primary'), btn('cancelado', 'Recusar', 'ghost danger'));
  if (a.status === 'confirmado') {
    list.push(btn('concluido', 'Concluído'), btn('faltou', 'Faltou'), btn('remarcar', 'Remarcar'), btn('cancelado', 'Cancelar', 'ghost danger'));
  }
  if (['concluido', 'faltou'].includes(a.status)) list.push(btn('confirmado', 'Desfazer'));
  if (a.status !== 'cancelado') list.push(btn('nota', `${icon('note')} Anotação`));
  return list.join('');
}

function apptCard(a, withDate = false) {
  const wa = a.client_phone ? whatsapp(a.client_phone) : '';
  return `
    <article class="card appt ${a.status}">
      <div class="appt-when">${withDate ? `<small class="when-day">${esc(fmtDay(a.starts_at, { weekday: 'short', day: 'numeric', month: 'short' }))}</small>` : ''}
        <b>${timeOf(a.starts_at)}</b><small>${timeOf(a.ends_at)}</small></div>
      <div class="appt-main">
        <div class="appt-top"><b>${esc(a.client_name)}</b>${statusBadge(a.status, true)}</div>
        <div>${esc(a.service_name)}</div>
        ${a.client_phone || a.client_email ? `<small class="contact">
          ${a.client_phone ? `<a href="tel:${esc(a.client_phone)}">${icon('phone')} ${esc(a.client_phone)}</a>` : ''}
          ${wa ? `<a href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          ${a.client_email ? `<a href="mailto:${esc(a.client_email)}">${esc(a.client_email)}</a>` : ''}</small>` : ''}
        ${a.notes ? `<small class="appt-notes">${icon('note')} ${esc(a.notes)}</small>` : ''}
      </div>
      <div class="appt-actions">${actionsFor(a)}</div>
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

export async function agenda(el) {
  const pid = currentPid();
  if (!pid) return noProfessional(el);
  const from = view.mode === 'dia' ? view.date : addDays(view.date, -weekdayIndex(view.date));
  const to = view.mode === 'dia' ? from : addDays(from, 6);
  const step = view.mode === 'dia' ? 1 : 7;

  el.innerHTML = `
    <div class="page wide">
      <div class="page-head"><h1>Agenda</h1>${profPicker(pid)}
        <button class="btn primary" id="new">${icon('plus')} Agendar</button></div>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Visualização">
          <button data-mode="dia" class="${view.mode === 'dia' ? 'active' : ''}">Dia</button>
          <button data-mode="semana" class="${view.mode === 'semana' ? 'active' : ''}">Semana</button>
        </div>
        <div class="date-nav">
          <button class="icon-btn" data-move="-1" aria-label="Anterior">${icon('left')}</button>
          <button class="btn small ghost" data-move="0">Hoje</button>
          <button class="icon-btn" data-move="1" aria-label="Próximo">${icon('right')}</button>
          <input type="date" id="goto" value="${view.date}" aria-label="Ir para a data">
        </div>
        <label class="check"><input type="checkbox" id="show-cancelled"${view.showCancelled ? ' checked' : ''}> Mostrar cancelados</label>
      </div>
      <div id="pending"></div>
      <h2 class="range-title">${rangeTitle(from, to)} <small class="muted" id="count"></small></h2>
      <div id="list">${spinner()}</div>
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

  page.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const appt = loaded.find((a) => a.id === b.dataset.id);
    const act = b.dataset.act;
    if (act === 'remarcar') return appointmentForm(pid, appt, rerender);
    if (act === 'nota') return noteForm(appt, rerender);
    if (act === 'cancelado' && !await confirmDialog(
      `${appt.status === 'pendente' ? 'Recusar' : 'Cancelar'} o atendimento de ${appt.client_name}?`,
      { okLabel: appt.status === 'pendente' ? 'Recusar' : 'Cancelar atendimento', danger: true })) return undefined;
    return busy(b, async () => {
      await api.updateAppointment(appt.id, { status: act });
      toast('Agendamento atualizado.');
      rerender();
    });
  });

  let loaded = [];
  const [appointments, pending] = await Promise.all([api.agenda(pid, from, to), api.pending(pid)]);
  loaded = [...appointments, ...pending];

  if (pending.length) {
    page.querySelector('#pending').innerHTML = `
      <section class="pending-box">
        <h2 class="section-title">${icon('clock')} Aguardando confirmação (${pending.length})</h2>
        <div class="list">${pending.map((a) => apptCard(a, true)).join('')}</div>
      </section>`;
  }

  const visible = appointments.filter((a) => view.showCancelled || a.status !== 'cancelado');
  const active = appointments.filter((a) => a.status !== 'cancelado').length;
  page.querySelector('#count').textContent = `· ${active} ${active === 1 ? 'atendimento' : 'atendimentos'}`;
  const days = Array.from({ length: step }, (_, i) => addDays(from, i));
  const list = page.querySelector('#list');
  if (view.mode === 'dia') {
    list.innerHTML = visible.length ? `<div class="list">${visible.map((a) => apptCard(a)).join('')}</div>`
      : empty('Nenhum atendimento neste dia.');
  } else {
    list.innerHTML = `<div class="week">${days.map((d) => {
      const items = visible.filter((a) => a.starts_at.startsWith(d));
      return `<section class="week-day${d === today() ? ' today' : ''}">
        <h3><button class="link" data-day="${d}">${esc(fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' }))}</button></h3>
        ${items.length ? `<div class="list">${items.map((a) => apptCard(a)).join('')}</div>` : '<p class="muted small">Livre</p>'}
      </section>`;
    }).join('')}</div>`;
    list.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      view.date = b.dataset.day;
      view.mode = 'dia';
      rerender();
    }));
  }
  return undefined;
}

// ------------------------------------------------ novo agendamento / remarcar

async function appointmentForm(pid, appt, onDone) {
  const all = await api.listServices(pid);
  const services = all.filter((s) => s.active);
  if (!services.length) {
    toast('Cadastre um serviço antes de agendar.', 'error');
    return;
  }
  const reschedule = Boolean(appt);
  const m = modal({
    title: reschedule ? `Remarcar — ${appt.client_name}` : 'Novo agendamento',
    submitLabel: reschedule ? 'Remarcar' : 'Agendar',
    body: `
      ${reschedule ? `<p class="muted">${esc(appt.service_name)} · atual: ${esc(fmtDay(appt.starts_at))} às ${timeOf(appt.starts_at)}</p>` : `
      <label>Nome do cliente<input name="client_name" list="clients-dl" required autocomplete="off" maxlength="120"></label>
      <datalist id="clients-dl"></datalist>
      <div class="row">
        <label>Telefone<input name="client_phone" type="tel" autocomplete="off"></label>
        <label>E-mail <small class="muted">(se tiver conta)</small><input name="client_email" type="email" autocomplete="off"></label>
      </div>
      <label>Serviço<select name="service_id">${services.map((s) => `
        <option value="${s.id}">${esc(s.name)} (${fmtDuration(s.duration_min)})</option>`).join('')}</select></label>`}
      <label>Data<input name="date" type="date" required value="${reschedule ? appt.starts_at.slice(0, 10) : view.date < today() ? today() : view.date}"></label>
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
        await api.updateAppointment(appt.id, { date: data.date, time });
        toast('Atendimento remarcado.');
      } else {
        await api.createAppointment({ ...data, professional_id: pid, time });
        toast('Atendimento agendado.');
      }
      onDone();
      return true;
    },
  });

  const form = m.form;
  const slotsEl = form.querySelector('#f-slots');
  const freeInput = form.elements.time_free;
  let chosen = null;
  let seq = 0;
  const serviceId = () => (reschedule ? appt.service_id : form.elements.service_id.value);
  const loadSlots = async () => {
    const mine = ++seq;
    chosen = null;
    slotsEl.innerHTML = spinner();
    try {
      const slots = await api.slots(pid, serviceId(), form.elements.date.value);
      if (mine !== seq) return;
      slotsEl.innerHTML = slots.length
        ? slots.map((t) => `<button type="button" class="slot" data-time="${t}">${t}</button>`).join('')
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
    // Sugestões de clientes já atendidos
    const nameInput = form.elements.client_name;
    const dl = form.querySelector('#clients-dl');
    let found = [];
    let timer;
    nameInput.addEventListener('input', () => {
      const match = found.find((c) => c.name === nameInput.value);
      if (match) {
        form.elements.client_phone.value = match.phone || '';
        form.elements.client_email.value = match.email || '';
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (nameInput.value.trim().length < 2) return;
        try {
          found = await api.clientSuggestions(pid, nameInput.value.trim());
          dl.innerHTML = found.map((c) => `<option value="${esc(c.name)}">${esc(c.phone || c.email || '')}</option>`).join('');
        } catch { /* sugestões são opcionais */ }
      }, 250);
    });
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
