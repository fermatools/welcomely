// Utilitários de interface: escape de HTML, ícones, datas, avisos e diálogos.

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19.5c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.4c2 .8 3.2 2.6 3.7 5.1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  list: '<path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12"/><circle cx="4" cy="6.5" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17.5" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  phone: '<path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4M8.2 13.2l7.6 4"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  logout: '<path d="M14 4.5H6.5v15H14M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5"/>',
  note: '<path d="M6 3.5h9l4 4v13H6z"/><path d="M9.5 12h6M9.5 15.5h6"/>',
};

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---------------------------------------------------------------- datas
// Datas trafegam como texto: "AAAA-MM-DD" e "AAAA-MM-DDTHH:MM" (hora local do profissional).

const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); };
export const today = () => isoDate(new Date());
export const nowStamp = () => { const d = new Date(); return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const timeOf = (stamp) => stamp.slice(11, 16);
// Segunda = 0 ... domingo = 6 (mesma convenção da API)
export const weekdayIndex = (s) => (parseDate(s).getDay() + 6) % 7;
export const WEEKDAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

export function fmtDay(s, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const text = parseDate(s).toLocaleDateString('pt-BR', opts);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function fmtRelativeDay(s) {
  if (s === today()) return 'Hoje';
  if (s === addDays(today(), 1)) return 'Amanhã';
  return fmtDay(s);
}

export const fmtDuration = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`);

// ---------------------------------------------------------------- situação

export const STATUS = {
  pendente: { label: 'Aguardando confirmação', short: 'Pendente', cls: 'warn' },
  confirmado: { label: 'Confirmado', short: 'Confirmado', cls: 'ok' },
  concluido: { label: 'Concluído', short: 'Concluído', cls: 'info' },
  faltou: { label: 'Não compareceu', short: 'Faltou', cls: 'danger' },
  cancelado: { label: 'Cancelado', short: 'Cancelado', cls: 'muted' },
};

export const statusBadge = (status, short = false) => {
  const s = STATUS[status] || { label: status, short: status, cls: 'muted' };
  return `<span class="badge ${s.cls}">${esc(short ? s.short : s.label)}</span>`;
};

// ---------------------------------------------------------------- formulários

export function formData(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
    else if (el.type === 'number') data[el.name] = el.value === '' ? null : Number(el.value);
    else data[el.name] = el.value;
  }
  return data;
}

// Desabilita o botão de envio enquanto a ação roda e mostra o erro, se houver.
export async function busy(button, action) {
  const label = button?.innerHTML;
  if (button) { button.disabled = true; button.classList.add('loading'); }
  try {
    return await action();
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  } finally {
    if (button) { button.disabled = false; button.classList.remove('loading'); button.innerHTML = label; }
  }
}

// ---------------------------------------------------------------- avisos e diálogos

export function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 5000 : 3000);
  setTimeout(() => el.remove(), kind === 'error' ? 5400 : 3400);
}

// Abre um diálogo com o HTML dado; devolve { el, close }. onSubmit recebe o <form> se houver.
export function modal({ title, body, submitLabel, onSubmit, wide = false }) {
  const dialog = document.createElement('dialog');
  dialog.className = `modal${wide ? ' wide' : ''}`;
  dialog.innerHTML = `
    <form method="dialog" class="modal-box" novalidate>
      <header class="modal-head"><h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></header>
      <div class="modal-body">${body}</div>
      ${submitLabel ? `<footer class="modal-foot">
        <button type="button" class="btn ghost" data-close>Voltar</button>
        <button type="submit" class="btn primary">${esc(submitLabel)}</button></footer>` : ''}
    </form>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) close();
  });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  const form = dialog.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    if (!form.reportValidity()) return;
    let failed = false;
    const result = await busy(form.querySelector('[type=submit]'), async () => {
      try { return await onSubmit(form); } catch (err) { failed = true; throw err; }
    });
    if (!failed && result !== false) close();  // onSubmit devolve false para manter aberto
  });
  dialog.showModal();
  return { el: dialog, form, close };
}

export function confirmDialog(message, { okLabel = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title: 'Confirmar',
      body: `<p>${esc(message)}</p>`,
      submitLabel: okLabel,
      onSubmit: () => { answered = true; resolve(true); return true; },
    });
    if (danger) m.form.querySelector('[type=submit]').classList.add('danger');
    m.el.addEventListener('close', () => { if (!answered) resolve(false); });
  });
}

export function empty(text, iconName = 'calendar') {
  return `<div class="empty">${icon(iconName)}<p>${esc(text)}</p></div>`;
}

export const spinner = () => '<div class="spinner" role="status" aria-label="Carregando"></div>';
