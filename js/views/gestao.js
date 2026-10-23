import * as api from '../api.js';
import { currentPid } from '../state.js';
import {
  addDays, busy, confirmDialog, empty, esc, fmtDay, fmtDuration, formData, icon, modal, spinner, timeOf, toast,
  today,
} from '../ui.js';
import { normalizeRule, validateAvailability } from '../data/logic.js';
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

const SHORT_DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const ORDINAL = { 1: '1ª', 2: '2ª', 3: '3ª', 4: '4ª', '-1': 'última' };
const fmtDate = (s) => (s ? fmtDay(s, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const joinPt = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}` : list[0] || '');

/** Descrição da regra em português, como no Google Agenda. */
function describeRule(raw) {
  const r = normalizeRule(raw);
  const time = `${r.start_time}–${r.end_time}`;
  if (r.repeat === 'once') return { when: fmtDay(r.date), time, repeat: 'Só nesta data' };
  const days = joinPt(r.days.map((d) => SHORT_DAYS[d]));
  const repeat = r.repeat === 'monthly'
    ? `Todo mês, na ${ORDINAL[r.week_of_month]} semana`
    : r.interval > 1 ? `A cada ${r.interval} semanas` : 'Toda semana';
  const range = r.from && r.until ? ` · de ${fmtDate(r.from)} a ${fmtDate(r.until)}`
    : r.from ? ` · a partir de ${fmtDate(r.from)}` : r.until ? ` · até ${fmtDate(r.until)}` : '';
  return { when: days, time, repeat: repeat + range };
}

export async function hours(el) {
  const pid = currentPid();
  if (!pid) return noProfessional(el);
  el.innerHTML = `<div class="page">${spinner()}</div>`;
  const [rules, blocks] = await Promise.all([api.getAvailability(pid), api.listBlocks(pid)]);

  el.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Horários</h1>${profPicker(pid)}</div>
      <section class="card">
        <div class="section-head"><h2>Horários de atendimento</h2>
          <button class="btn small" id="new-rule">${icon('plus')} Nova regra</button></div>
        <p class="muted small">Quando os clientes podem agendar. Como no Google Agenda, cada regra pode repetir toda semana,
          a cada algumas semanas, uma vez por mês ou valer só numa data.</p>
        <div class="list">${rules.length ? rules.map((r, i) => {
          const d = describeRule(r);
          return `
          <div class="block-row">
            <div><b>${esc(d.when)}</b> · ${esc(d.time)}<br><small class="muted">${esc(d.repeat)}</small></div>
            <div class="row-actions">
              <button class="icon-btn" data-edit-rule="${i}" aria-label="Editar regra">${icon('edit')}</button>
              <button class="icon-btn danger" data-del-rule="${i}" aria-label="Excluir regra">${icon('trash')}</button>
            </div>
          </div>`;
        }).join('') : '<p class="muted small">Nenhuma regra: ninguém consegue agendar. Crie a primeira.</p>'}</div>
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
  const saveRules = async (list, message) => {
    await api.setAvailability(pid, list);
    toast(message);
    rerender();
  };
  bindPicker(el, rerender);
  el.querySelector('#new-rule').addEventListener('click', () => ruleForm(null, (rule) => saveRules([...rules, rule], 'Regra criada.')));
  el.querySelector('#new-block').addEventListener('click', () => blockForm(pid, rerender));
  el.querySelector('.page').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit-rule]');
    if (edit) {
      const i = Number(edit.dataset.editRule);
      ruleForm(rules[i], (rule) => saveRules(rules.map((r, j) => (j === i ? rule : r)), 'Regra alterada.'));
      return;
    }
    const delRule = e.target.closest('[data-del-rule]');
    if (delRule) {
      if (!await confirmDialog('Excluir esta regra de horário?', { okLabel: 'Excluir', danger: true })) return;
      busy(delRule, () => saveRules(rules.filter((_, j) => j !== Number(delRule.dataset.delRule)), 'Regra excluída.'));
      return;
    }
    const del = e.target.closest('[data-del-block]');
    if (!del || !await confirmDialog('Remover este bloqueio?', { okLabel: 'Remover', danger: true })) return;
    busy(del, async () => {
      await api.deleteBlock(pid, del.dataset.delBlock);
      toast('Bloqueio removido.');
      rerender();
    });
  });
  return undefined;
}

// Formulário de regra. Repetição: weekly-1..4 (toda semana / a cada N semanas), monthly, once.
function ruleForm(raw, onSave) {
  const r = raw ? normalizeRule(raw) : {
    repeat: 'weekly', days: [0, 1, 2, 3, 4], start_time: '09:00', end_time: '12:00', interval: 1, week_of_month: 1,
    date: today(), from: '', until: '',
  };
  const repeatValue = r.repeat === 'weekly' ? `weekly-${r.interval}` : r.repeat;
  const options = [['weekly-1', 'Toda semana'], ['weekly-2', 'A cada 2 semanas'], ['weekly-3', 'A cada 3 semanas'],
    ['weekly-4', 'A cada 4 semanas'], ['monthly', 'Uma vez por mês'], ['once', 'Só numa data']];
  const m = modal({
    title: raw ? 'Editar regra de horário' : 'Nova regra de horário',
    submitLabel: 'Salvar',
    body: `
      <label>Repetição<select name="repeat">
        ${options.map(([v, l]) => `<option value="${v}"${v === repeatValue ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <div class="field" data-show="weekly monthly">
        <span class="field-label">Dias da semana</span>
        <div class="weekday-chips">${SHORT_DAYS.map((d, i) => `
          <label class="chip-check"><input type="checkbox" name="day" value="${i}"${r.days.includes(i) ? ' checked' : ''}><span>${d}</span></label>`).join('')}</div>
      </div>
      <label data-show="monthly">Semana do mês<select name="week_of_month">
        ${[1, 2, 3, 4, -1].map((w) => `<option value="${w}"${w === r.week_of_month ? ' selected' : ''}>${w === -1 ? 'Última' : `${w}ª`} semana do mês</option>`).join('')}
      </select></label>
      <label data-show="once">Data<input name="date" type="date" value="${r.date || today()}"></label>
      <div class="row">
        <label>Das<input name="start_time" type="time" required value="${r.start_time}"></label>
        <label>Às<input name="end_time" type="time" required value="${r.end_time}"></label>
      </div>
      <div class="row" data-show="weekly monthly">
        <label>A partir de <small class="muted">(opcional)</small><input name="from" type="date" value="${r.from}"></label>
        <label>Até <small class="muted">(opcional)</small><input name="until" type="date" value="${r.until}"></label>
      </div>
      <p class="muted small" data-show="weekly-n">As semanas contam a partir da data inicial (se ficar em branco, a partir de hoje).</p>`,
    onSubmit: async (form) => {
      const [kind, n] = form.elements.repeat.value.split('-');
      const days = [...form.querySelectorAll('[name=day]:checked')].map((c) => Number(c.value));
      let from = form.elements.from.value;
      if (kind === 'weekly' && Number(n) > 1 && !from) from = today();
      const rule = validateAvailability([{
        repeat: kind, days, start_time: form.elements.start_time.value, end_time: form.elements.end_time.value,
        interval: Number(n) || 1, week_of_month: Number(form.elements.week_of_month.value),
        date: form.elements.date.value, from, until: form.elements.until.value,
      }])[0];
      await onSave(rule);
      return true;
    },
  });
  const sync = () => {
    const v = m.form.elements.repeat.value;
    const kind = v.split('-')[0];
    m.form.querySelectorAll('[data-show]').forEach((x) => {
      const show = x.dataset.show.split(' ');
      x.hidden = !(show.includes(kind) || (show.includes('weekly-n') && kind === 'weekly' && v !== 'weekly-1'));
    });
  };
  m.form.elements.repeat.addEventListener('change', sync);
  sync();
}

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
