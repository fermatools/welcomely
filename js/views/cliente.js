import * as api from '../api.js';
import { addToCalendar, eventFor } from '../calendar.js';
import { canManage, go, saveRedirect, state } from '../state.js';
import {
  addDays, busy, confirmDialog, empty, esc, fmtDay, fmtDuration, fmtRelativeDay, icon, nowStamp, parseDate,
  spinner, statusBadge, timeOf, toast, today,
} from '../ui.js';
import { rulesForDay } from '../data/logic.js';

/** "hoje", "amanhã" ou "em seg., 2 de nov." */
const whenText = (d) => {
  const rel = fmtRelativeDay(d).toLowerCase();
  return ['hoje', 'amanhã'].includes(rel) ? rel : `em ${rel}`;
};
const initials = (name) => name.replace(/^(Dra?|Pe|Pr|Sr|Sra)\.\s*/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('');

function profCard(p) {
  return `
    <a class="card prof-card" href="#/p/${p.id}">
      <span class="avatar">${esc(initials(p.name))}</span>
      <span class="prof-info"><b>${esc(p.name)}</b>
        ${p.title ? `<span>${esc(p.title)}</span>` : ''}
        ${p.location ? `<small class="muted">${icon('pin')} ${esc(p.location)}</small>` : ''}
        ${p.groups?.length ? `<small class="muted">${icon('users')} ${esc(p.groups.join(' · '))}</small>` : ''}</span>
      ${icon('right', 'chev')}
    </a>`;
}

export async function search(el) {
  el.innerHTML = `
    <div class="page">
      <h1>Com quem você quer agendar?</h1>
      <label class="search">${icon('search')}
        <input type="search" placeholder="Nome, especialidade ou local" aria-label="Buscar profissional"></label>
      <div class="list" id="results">${spinner()}</div>
    </div>`;
  const input = el.querySelector('input');
  const results = el.querySelector('#results');
  let timer;
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    try {
      const professionals = await api.listProfessionals(input.value);
      if (mine !== seq) return;
      results.innerHTML = professionals.length ? professionals.map(profCard).join('')
        : empty(state.groups.length || state.user.role === 'admin' ? 'Nenhum atendente encontrado.'
          : 'Você ainda não faz parte de nenhum grupo. Peça o link de convite ao seu atendente.', 'search');
    } catch (err) { results.innerHTML = `<div class="card error-box">${esc(err.message)}</div>`; }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  await load();
}

export async function professionalPage(el, id) {
  const { professional: p, availability, services } = await api.getProfessional(id);
  const manager = canManage(id);
  const ahead = Number(p.max_days_ahead) > 0 ? Number(p.max_days_ahead) : 60;
  const lastDay = addDays(today(), ahead);
  // Dias com regra de horário (os outros aparecem apagados); a página abre no primeiro deles
  const isOpen = (d) => rulesForDay(availability, d).length > 0;
  const openDays = [];
  for (let d = today(); d <= lastDay && openDays.length < 60; d = addDays(d, 1)) if (isOpen(d)) openDays.push(d);
  const sel = { service: services[0]?.id ?? null, date: openDays[0] || today(), time: null };

  el.innerHTML = `
    <div class="page narrow">
      <section class="card prof-header">
        <span class="avatar big">${esc(initials(p.name))}</span>
        <div>
          <h1>${esc(p.name)}</h1>
          ${p.title ? `<p class="lead">${esc(p.title)}</p>` : ''}
          ${p.location ? `<p class="muted">${icon('pin')} ${esc(p.location)}</p>` : ''}
        </div>
        ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
      </section>
      ${manager ? `<div class="card note">Você gerencia esta agenda. Para marcar um cliente, use a
        <a href="#/agenda">Agenda</a>.</div>` : ''}
      ${!services.length ? empty('Este atendente ainda não tem serviços disponíveis.', 'list') : `
      <section class="step">
        <h2><span class="num">1</span> Tipo de atendimento</h2>
        <div class="chips" id="services">
          ${services.map((s) => `
            <button type="button" class="chip-card" data-service="${s.id}">
              <b>${esc(s.name)}</b><small>${fmtDuration(s.duration_min)}</small>
              ${s.description ? `<small class="muted">${esc(s.description)}</small>` : ''}
            </button>`).join('')}
        </div>
      </section>
      <section class="step">
        <h2><span class="num">2</span> Dia</h2>
        ${!availability.length ? '<p class="card note">Este atendente ainda não definiu os horários de atendimento.</p>'
          : !openDays.length ? '<p class="card note">Não há dias de atendimento dentro do prazo de agendamento deste atendente.</p>' : ''}
        ${ahead < 14 ? `<p class="muted small">Este atendente aceita agendamentos com até ${ahead} dia${ahead === 1 ? '' : 's'} de antecedência.</p>` : ''}
        <div class="day-strip" id="days"></div>
        <label class="inline-date">Outra data: <input type="date" id="pick-date" min="${today()}" max="${lastDay}"></label>
      </section>
      <section class="step">
        <h2><span class="num">3</span> Horário</h2>
        <div id="slots" class="slots"></div>
      </section>
      <section class="step">
        <label>Observações para o atendimento <small class="muted">(opcional)</small>
          <textarea id="notes" rows="2" maxlength="1000" placeholder="Algo que o profissional deva saber"></textarea></label>
        <div id="summary" class="summary"></div>
        <button class="btn primary block" id="book" disabled>Escolha um horário</button>
        <p class="muted small center">${p.requires_confirmation
          ? 'O agendamento fica pendente até o profissional confirmar.'
          : 'O agendamento é confirmado na hora.'}
          ${p.cancel_notice_hours ? ` Cancelamentos até ${p.cancel_notice_hours} h antes.` : ''}</p>
      </section>`}
    </div>`;
  if (!services.length) return;

  const daysEl = el.querySelector('#days');
  const slotsEl = el.querySelector('#slots');
  const bookBtn = el.querySelector('#book');

  const renderDays = () => {
    const days = Array.from({ length: Math.min(14, ahead + 1) }, (_, i) => addDays(today(), i));
    if (!days.includes(sel.date)) days.push(sel.date);
    daysEl.innerHTML = days.map((d) => {
      const date = parseDate(d);
      return `<button type="button" class="day${d === sel.date ? ' active' : ''}${isOpen(d) ? '' : ' off'}" data-date="${d}"
        ${isOpen(d) ? '' : 'title="Sem atendimento neste dia"'}>
        <small>${date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</small>
        <b>${date.getDate()}</b><small>${date.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</small></button>`;
    }).join('');
    daysEl.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  };

  const renderSummary = () => {
    const service = services.find((s) => s.id === sel.service);
    el.querySelectorAll('[data-service]').forEach((b) => b.classList.toggle('active', b.dataset.service === sel.service));
    el.querySelector('#summary').innerHTML = sel.time
      ? `${icon('calendar')} <span><b>${esc(service.name)}</b> · ${fmtDay(sel.date)} às <b>${sel.time}</b></span>` : '';
    bookBtn.disabled = !sel.time;
    bookBtn.textContent = !sel.time ? 'Escolha um horário' : state.user ? 'Confirmar agendamento' : 'Entrar para agendar';
  };

  let seq = 0;
  const loadSlots = async () => {
    const mine = ++seq;
    sel.time = null;
    renderSummary();
    slotsEl.innerHTML = spinner();
    try {
      const slots = await api.slots(id, sel.service, sel.date);
      if (mine !== seq) return;
      const next = openDays.find((d) => d > sel.date);
      slotsEl.innerHTML = slots.length
        ? slots.map((t) => `<button type="button" class="slot" data-time="${t}">${t}</button>`).join('')
        : `<p class="muted">${isOpen(sel.date) ? 'Sem horários livres' : 'Sem atendimento'} ${whenText(sel.date)}.</p>
          ${next ? `<button type="button" class="btn small" data-next="${next}">Ver ${esc(fmtDay(next).toLowerCase())}</button>` : ''}`;
    } catch (err) { slotsEl.innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
  };

  el.querySelector('#services').addEventListener('click', (e) => {
    const b = e.target.closest('[data-service]');
    if (!b) return;
    sel.service = b.dataset.service;
    loadSlots();
  });
  daysEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-date]');
    if (!b) return;
    sel.date = b.dataset.date;
    renderDays();
    loadSlots();
  });
  el.querySelector('#pick-date').addEventListener('change', (e) => {
    if (!e.target.value) return;
    sel.date = e.target.value;
    renderDays();
    loadSlots();
  });
  slotsEl.addEventListener('click', (e) => {
    const n = e.target.closest('[data-next]');
    if (n) {
      sel.date = n.dataset.next;
      renderDays();
      loadSlots();
      return;
    }
    const b = e.target.closest('[data-time]');
    if (!b) return;
    sel.time = b.dataset.time;
    slotsEl.querySelectorAll('.slot').forEach((s) => s.classList.toggle('active', s === b));
    renderSummary();
  });
  bookBtn.addEventListener('click', () => {
    if (!state.user) {
      saveRedirect(location.hash);
      go('#/entrar');
      return;
    }
    busy(bookBtn, async () => {
      try {
        const appointment = await api.createAppointment({
          professional_id: id, service_id: sel.service, date: sel.date, time: sel.time, notes: el.querySelector('#notes').value,
        });
        toast(appointment.status === 'pendente' ? 'Pedido enviado! Aguarde a confirmação.' : 'Agendamento confirmado!');
        go('#/meus');
      } catch (err) {
        if (err.status === 409) loadSlots();
        throw err;
      }
    });
  });

  renderDays();
  loadSlots();
}

function apptCard(a, actions) {
  return `
    <article class="card appt ${a.status}">
      <div class="appt-when"><b>${timeOf(a.starts_at)}</b><small>${timeOf(a.ends_at)}</small></div>
      <div class="appt-main">
        <div class="appt-top"><b>${esc(a.professional_name)}</b>${statusBadge(a.status, true)}</div>
        <div>${esc(a.service_name)}${a.professional_title ? ` · <span class="muted">${esc(a.professional_title)}</span>` : ''}</div>
        <small class="muted">${fmtDay(a.starts_at.slice(0, 10))}${a.professional_location ? ` · ${esc(a.professional_location)}` : ''}</small>
        ${a.notes ? `<small class="appt-notes">${icon('note')} ${esc(a.notes)}</small>` : ''}
      </div>
      ${actions ? `<div class="appt-actions">${actions}</div>` : ''}
    </article>`;
}

export async function mine(el) {
  el.innerHTML = `<div class="page">${spinner()}</div>`;
  const appointments = await api.myAppointments();
  const now = nowStamp();
  const upcoming = appointments.filter((a) => a.ends_at >= now && ['pendente', 'confirmado'].includes(a.status)).reverse();
  const past = appointments.filter((a) => !upcoming.includes(a));

  el.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Meus agendamentos</h1>
        <a class="btn primary" href="#/buscar">${icon('plus')} Agendar</a></div>
      <h2 class="section-title">Próximos</h2>
      <div class="list">${upcoming.length ? upcoming.map((a) => apptCard(a,
        `<button class="btn small ghost" data-cal="${a.id}">${icon('calendar')} Adicionar à agenda</button>
         <button class="btn small ghost danger" data-cancel="${a.id}">Cancelar</button>
         <a class="btn small ghost" href="#/p/${a.professional_id}">Agendar de novo</a>`)).join('')
        : empty('Você não tem atendimentos marcados.')}</div>
      ${past.length ? `<h2 class="section-title">Histórico</h2>
        <div class="list">${past.slice(0, 50).map((a) => apptCard(a)).join('')}</div>` : ''}
    </div>`;

  el.querySelector('.page').addEventListener('click', async (e) => {
    const cal = e.target.closest('[data-cal]');
    if (cal) {
      addToCalendar(eventFor(appointments.find((a) => a.id === cal.dataset.cal), true));
      return;
    }
    const b = e.target.closest('[data-cancel]');
    if (!b) return;
    if (!await confirmDialog('Cancelar este agendamento?', { okLabel: 'Cancelar agendamento', danger: true })) return;
    busy(b, async () => {
      await api.updateAppointment(b.dataset.cancel, { status: 'cancelado' });
      toast('Agendamento cancelado.');
      mine(el);
    });
  });
}
