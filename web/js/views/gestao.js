import * as api from '../api.js';
import { currentPid } from '../state.js';
import {
  addDays, busy, confirmDialog, empty, esc, fmtDay, fmtDuration, formData, icon, modal, spinner, timeOf, toast,
  today, WEEKDAYS,
} from '../ui.js';
import { bindPicker, noProfessional, profPicker } from './agenda.js';

// ---------------------------------------------------------------- serviços

export async function services(el) {
  const pid = currentPid();
  if (!pid) return noProfessional(el);
  el.innerHTML = `<div class="page">${spinner()}</div>`;
  const list = await api.listServices(pid);
  el.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Serviços</h1>${profPicker(pid)}
        <button class="btn primary" id="new">${icon('plus')} Novo serviço</button></div>
      <p class="muted">Tipos de atendimento que os clientes podem escolher, com a duração de cada um.</p>
      <div class="list">${list.length ? list.map((s) => `
        <article class="card service${s.active ? '' : ' inactive'}">
          <div><b>${esc(s.name)}</b> <span class="badge ${s.active ? 'info' : 'muted'}">${fmtDuration(s.duration_min)}</span>
            ${s.active ? '' : '<span class="badge muted">Inativo</span>'}
            ${s.description ? `<p class="muted small">${esc(s.description)}</p>` : ''}</div>
          <div class="row-actions">
            <button class="icon-btn" data-edit="${s.id}" aria-label="Editar">${icon('edit')}</button>
            <button class="icon-btn danger" data-del="${s.id}" aria-label="Excluir">${icon('trash')}</button>
          </div>
        </article>`).join('') : empty('Nenhum serviço cadastrado.', 'list')}</div>
    </div>`;
  const rerender = () => services(el);
  bindPicker(el, rerender);
  el.querySelector('#new').addEventListener('click', () => serviceForm(pid, null, rerender));
  el.querySelector('.page').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) serviceForm(pid, list.find((s) => s.id === edit.dataset.edit), rerender);
    const del = e.target.closest('[data-del]');
    if (del && await confirmDialog('Excluir este serviço? Se já houver agendamentos com ele, será apenas desativado.',
      { okLabel: 'Excluir', danger: true })) {
      busy(del, async () => {
        const res = await api.deleteService(pid, del.dataset.del);
        toast(res.deactivated ? 'Serviço desativado (há agendamentos com ele).' : 'Serviço excluído.');
        rerender();
      });
    }
  });
  return undefined;
}

function serviceForm(pid, s, onDone) {
  modal({
    title: s ? 'Editar serviço' : 'Novo serviço',
    submitLabel: 'Salvar',
    body: `
      <label>Nome<input name="name" required maxlength="120" value="${esc(s?.name)}" placeholder="Ex.: Consulta, Confissão, Sessão"></label>
      <label>Descrição <small class="muted">(opcional)</small><textarea name="description" rows="2" maxlength="1000">${esc(s?.description)}</textarea></label>
      <label>Duração (minutos)<input name="duration_min" type="number" min="5" max="600" step="5" required value="${s?.duration_min ?? 30}"></label>
      <label class="check"><input type="checkbox" name="active"${!s || s.active ? ' checked' : ''}> Disponível para agendamento</label>`,
    onSubmit: async (form) => {
      const data = formData(form);
      await api.saveService(pid, s?.id, data);
      toast('Serviço salvo.');
      onDone();
      return true;
    },
  });
}

// ------------------------------------------------- horários e bloqueios

export async function hours(el) {
  const pid = currentPid();
  if (!pid) return noProfessional(el);
  el.innerHTML = `<div class="page">${spinner()}</div>`;
  const [rules, blocks] = await Promise.all([api.getAvailability(pid), api.listBlocks(pid)]);
  const week = WEEKDAYS.map((_, wd) => rules.filter((r) => r.weekday === wd).map((r) => ({ ...r })));

  el.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Horários</h1>${profPicker(pid)}</div>
      <section class="card">
        <h2>Horários de atendimento</h2>
        <p class="muted small">Intervalos em que os clientes podem agendar, em cada dia da semana.</p>
        <div id="week" class="week-editor"></div>
        <div class="form-foot"><button class="btn primary" id="save-week">Salvar horários</button></div>
      </section>
      <section class="card">
        <div class="section-head"><h2>Bloqueios</h2>
          <button class="btn small" id="new-block">${icon('plus')} Bloquear período</button></div>
        <p class="muted small">Férias, compromissos ou feriados: ninguém consegue agendar nesses períodos.</p>
        <div class="list">${blocks.length ? blocks.map((b) => `
          <div class="block-row">
            <div><b>${esc(b.reason || 'Indisponível')}</b><br><small class="muted">${esc(fmtBlock(b))}</small></div>
            <button class="icon-btn danger" data-del-block="${b.id}" aria-label="Remover bloqueio">${icon('trash')}</button>
          </div>`).join('') : '<p class="muted small">Nenhum bloqueio futuro.</p>'}</div>
      </section>
    </div>`;

  const rerender = () => hours(el);
  bindPicker(el, rerender);
  const weekEl = el.querySelector('#week');
  const renderWeek = () => {
    weekEl.innerHTML = week.map((intervals, wd) => `
      <div class="wd-row">
        <b class="wd-name">${WEEKDAYS[wd]}</b>
        <div class="wd-intervals">
          ${intervals.length ? intervals.map((r, i) => `
            <span class="interval">
              <input type="time" value="${r.start_time}" data-wd="${wd}" data-i="${i}" data-k="start_time" aria-label="Início">
              <span>às</span>
              <input type="time" value="${r.end_time}" data-wd="${wd}" data-i="${i}" data-k="end_time" aria-label="Fim">
              <button class="icon-btn" data-rm="${wd}:${i}" aria-label="Remover intervalo">${icon('x')}</button>
            </span>`).join('') : '<span class="muted small">Sem atendimento</span>'}
          <button class="btn small ghost" data-add="${wd}">${icon('plus')} Intervalo</button>
        </div>
      </div>`).join('');
  };
  weekEl.addEventListener('change', (e) => {
    const { wd, i, k } = e.target.dataset;
    if (k) week[wd][i][k] = e.target.value;
  });
  weekEl.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const list = week[add.dataset.add];
      const last = list[list.length - 1];
      list.push(last ? { start_time: last.end_time, end_time: last.end_time < '23:00' ? addHour(last.end_time) : '23:59' }
        : { start_time: '09:00', end_time: '12:00' });
      renderWeek();
    }
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const [wd, i] = rm.dataset.rm.split(':').map(Number);
      week[wd].splice(i, 1);
      renderWeek();
    }
  });
  el.querySelector('#save-week').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const payload = week.flatMap((list, wd) => list.map((r) => ({ weekday: wd, start_time: r.start_time, end_time: r.end_time })));
    await api.setAvailability(pid, payload);
    toast('Horários salvos.');
  }));
  el.querySelector('#new-block').addEventListener('click', () => blockForm(pid, rerender));
  el.querySelector('.page').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-block]');
    if (!del || !await confirmDialog('Remover este bloqueio?', { okLabel: 'Remover', danger: true })) return;
    busy(del, async () => {
      await api.deleteBlock(pid, del.dataset.delBlock);
      toast('Bloqueio removido.');
      rerender();
    });
  });
  renderWeek();
  return undefined;
}

const addHour = (hhmm) => `${String(Number(hhmm.slice(0, 2)) + 1).padStart(2, '0')}${hhmm.slice(2)}`;

function fmtBlock(b) {
  const sd = b.starts_at.slice(0, 10);
  const ed = b.ends_at.slice(0, 10);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  const allDay = timeOf(b.starts_at) === '00:00' && timeOf(b.ends_at) === '00:00';
  if (allDay) {
    const last = addDays(ed, -1);
    return last === sd ? `${fmtDay(sd, opts)} (dia inteiro)` : `${fmtDay(sd, opts)} a ${fmtDay(last, opts)}`;
  }
  return sd === ed ? `${fmtDay(sd, opts)}, ${timeOf(b.starts_at)} às ${timeOf(b.ends_at)}`
    : `${fmtDay(sd, opts)} ${timeOf(b.starts_at)} a ${fmtDay(ed, opts)} ${timeOf(b.ends_at)}`;
}

function blockForm(pid, onDone) {
  const m = modal({
    title: 'Bloquear período',
    submitLabel: 'Bloquear',
    body: `
      <label>Motivo <small class="muted">(opcional)</small><input name="reason" maxlength="200" placeholder="Ex.: Férias, retiro, congresso"></label>
      <label class="check"><input type="checkbox" name="all_day" checked> Dias inteiros</label>
      <div class="row">
        <label>De<input name="start_date" type="date" required value="${today()}"></label>
        <label class="time-field" hidden>Hora<input name="start_time" type="time" value="08:00"></label>
      </div>
      <div class="row">
        <label>Até<input name="end_date" type="date" required value="${today()}"></label>
        <label class="time-field" hidden>Hora<input name="end_time" type="time" value="12:00"></label>
      </div>`,
    onSubmit: async (form) => {
      const d = formData(form);
      const body = d.all_day
        ? { starts_at: `${d.start_date}T00:00`, ends_at: `${addDays(d.end_date, 1)}T00:00`, reason: d.reason }
        : { starts_at: `${d.start_date}T${d.start_time}`, ends_at: `${d.end_date}T${d.end_time}`, reason: d.reason };
      const res = await api.createBlock(pid, body);
      toast(res.conflicting_appointments
        ? `Período bloqueado. Atenção: ${res.conflicting_appointments} agendamento(s) já marcados nele continuam na agenda.`
        : 'Período bloqueado.', res.conflicting_appointments ? 'error' : 'ok');
      onDone();
      return true;
    },
  });
  m.form.elements.all_day.addEventListener('change', (e) => {
    m.form.querySelectorAll('.time-field').forEach((f) => { f.hidden = e.target.checked; });
  });
  m.form.elements.start_date.addEventListener('change', (e) => {
    if (m.form.elements.end_date.value < e.target.value) m.form.elements.end_date.value = e.target.value;
  });
}
