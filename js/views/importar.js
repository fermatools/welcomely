// Importar pessoas para um grupo: planilha (CSV ou Excel) ou contatos do celular (Chrome no Android).
import * as api from '../api.js';
import { esc, icon, modal, toast } from '../ui.js';

// SheetJS (só carregado quando a pessoa escolhe um arquivo do Excel)
const SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

const fold = (x) => String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const first = (v) => String(v ?? '').split(':::')[0].trim();   // Google Contatos junta vários valores com " ::: "

export const canPickContacts = () => Boolean(navigator.contacts?.select) && !window.WelcomelyAndroid;

// ------------------------------------------------------------------ leitura

/** CSV → matriz. Aceita ; , ou tab como separador e campos entre aspas. */
export function parseCsv(textValue) {
  const head = textValue.split(/\r?\n/, 1)[0];
  const sep = [';', '\t', ','].map((s) => [s, head.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < textValue.length; i++) {
    const ch = textValue[i];
    if (quoted) {
      if (ch === '"' && textValue[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && textValue[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  if (/\.(xlsx|xls|ods)$/i.test(file.name)) {
    const XLSX = await import(SHEETJS).catch(() => { throw new Error('Não foi possível carregar o leitor de Excel. Verifique a conexão ou salve a planilha como CSV.'); });
    const wb = XLSX.read(buf);
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  }
  let textValue = new TextDecoder('utf-8').decode(buf);
  if (textValue.includes('�')) textValue = new TextDecoder('windows-1252').decode(buf);   // CSV do Excel em português
  return parseCsv(textValue.replace(/^﻿/, ''));
}

const ROLE_WORDS = [
  [/^(atendente|profissional|padre|medic|psicolog|terapeuta)/, 'profissional'],
  [/^(auxiliar|secretari)/, 'auxiliar'],
  [/^(cliente|paciente|fiel)/, 'cliente'],
];
function roleOf(v) {
  const f = fold(v);
  if (!f) return 'cliente';
  return ROLE_WORDS.find(([re]) => re.test(f))?.[1] ?? null;
}

/** Matriz → [{name, email, phone, role, access}]. Reconhece cabeçalhos em português e o CSV do Google Contatos. */
export function rowsToPeople(matrix) {
  if (!matrix.length) return [];
  const header = matrix[0].map(fold);
  // primeiro padrão que achar coluna; colunas "... - Label"/"tipo" do Google Contatos nunca valem
  const find = (...res) => {
    for (const re of res) {
      const i = header.findIndex((h) => re.test(h) && !/label|type|rotulo/.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };
  let col = {
    name: find(/^(nome( completo)?|name|nome e sobrenome)$/),
    given: find(/^(first name|given name|primeiro nome|nome proprio)$/),
    middle: find(/^(middle name|additional name|nome do meio)$/),
    family: find(/^(last name|family name|sobrenome)$/),
    phone: find(/phone 1 - value|telefone 1 - valor/, /^(telefone|celular|fone|whatsapp|phone|tel)/),
    email: find(/e-?mail 1 - value|e-?mail 1 - valor/, /^(e-?mail|mail)/),
    role: find(/^(perfil|tipo|papel|funcao|role)$/),
    access: find(/^(acesso|nivel)$/),
  };
  const hasHeader = Object.values(col).some((i) => i >= 0);
  if (!hasHeader) col = { name: 0, phone: 1, email: 2, role: 3, given: -1, middle: -1, family: -1, access: -1 };
  const at = (r, i) => (i >= 0 ? first(r[i]) : '');
  return matrix.slice(hasHeader ? 1 : 0).map((r) => {
    const name = at(r, col.name) || [at(r, col.given), at(r, col.middle), at(r, col.family)].filter(Boolean).join(' ');
    let email = at(r, col.email);
    let phone = at(r, col.phone);
    if (!hasHeader && phone.includes('@') && !email.includes('@')) [phone, email] = [email, phone];
    const rawRole = at(r, col.role);
    const role = roleOf(rawRole);
    const access = /agenda/.test(fold(at(r, col.access)) || fold(rawRole)) ? 'agenda' : 'clientes';
    return { name: name.replace(/\s+/g, ' ').trim(), email: email.toLowerCase(), phone, role, rawRole, access };
  }).filter((p) => p.name || p.email || p.phone);
}

async function pickContacts() {
  const list = await navigator.contacts.select(['name', 'tel', 'email'], { multiple: true });
  return list.map((c) => ({
    name: (c.name?.[0] || '').trim(), phone: (c.tel?.[0] || '').trim(), email: (c.email?.[0] || '').trim().toLowerCase(),
    role: 'cliente', access: 'clientes',
  })).filter((p) => p.name || p.phone || p.email);
}

function downloadModel() {
  const csv = '﻿nome;telefone;e-mail;perfil\nMaria da Silva;(21) 99999-0000;maria@exemplo.com;cliente\nJosé Souza;21 98888-1111;;cliente\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'modelo-welcomely.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ telas

/** Abre o diálogo de importação para o grupo g (de api.groupMembers). onDone: recarregar a tela do grupo. */
export function importDialog(g, onDone) {
  const roles = g.canAdd.map((r) => api.ROLE_NAMES[r].toLowerCase()).join(', ');
  const m = modal({
    title: `Importar para ${g.name}`,
    body: `
      <p>Escolha uma planilha (<b>Excel</b> ou <b>CSV</b>) com uma linha por pessoa. Colunas reconhecidas:
        <b>nome</b>, <b>telefone</b>, <b>e-mail</b> e, se quiser, <b>perfil</b> (${esc(roles)}; vazio = cliente)
        e <b>acesso</b> do auxiliar ("agenda" = só agenda).</p>
      <p class="muted small">Também serve o arquivo exportado do Google Contatos (contacts.google.com → Exportar → CSV do Google).
        Clientes entram como <b>sem conta</b> (não recebem e-mail); quem já está no grupo, pelo e-mail ou telefone, é ignorado.</p>
      <label class="btn block">${icon('plus')} Escolher planilha
        <input type="file" id="file" accept=".csv,.txt,.xlsx,.xls,.ods" hidden></label>
      ${canPickContacts() && g.canAdd.includes('cliente')
        ? `<button type="button" class="btn block" id="contacts">${icon('users')} Escolher dos contatos do celular</button>` : ''}
      <p class="center small"><a href="#" id="model">Baixar planilha modelo</a></p>`,
  });
  const start = async (getPeople) => {
    try {
      const people = await getPeople();
      if (!people.length) { toast('Nenhuma pessoa encontrada.', 'error'); return; }
      m.close();
      preview(g, people, onDone);
    } catch (err) {
      if (err.name !== 'AbortError') toast(err.message, 'error');
    }
  };
  m.el.querySelector('#file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) start(async () => rowsToPeople(await readFile(file)));
  });
  m.el.querySelector('#contacts')?.addEventListener('click', () => start(pickContacts));
  m.el.querySelector('#model').addEventListener('click', (e) => { e.preventDefault(); downloadModel(); });
}

function problem(p, g) {
  if (!p.role) return `perfil "${p.rawRole}" desconhecido`;
  if (!g.canAdd.includes(p.role)) return `você não pode cadastrar ${api.ROLE_NAMES[p.role].toLowerCase()}`;
  if (!p.name) return 'sem nome';
  if (p.role === 'cliente' && !p.phone && !p.email) return 'sem telefone nem e-mail';
  if (p.role !== 'cliente' && !p.email) return 'precisa de e-mail';
  return '';
}

function preview(g, people, onDone) {
  const rows = people.map((p) => ({ ...p, problem: problem(p, g) }));
  const okCount = rows.filter((r) => !r.problem).length;
  const accounts = rows.filter((r) => !r.problem && r.role !== 'cliente').length;
  const m = modal({
    title: `Importar ${rows.length} pessoa${rows.length === 1 ? '' : 's'}`,
    wide: true,
    submitLabel: 'Importar marcadas',
    body: `
      <p class="muted small">Desmarque quem não quiser incluir.${accounts
        ? ` <b>${accounts}</b> atendente(s)/auxiliar(es) sem conta vão receber um e-mail para criar a senha.` : ''}</p>
      <label class="check"><input type="checkbox" id="all" checked> Marcar todas (${okCount})</label>
      <div class="import-list">${rows.map((r, i) => `
        <label class="import-row${r.problem ? ' bad' : ''}">
          <input type="checkbox" data-i="${i}"${r.problem ? ' disabled' : ' checked'}>
          <span><b>${esc(r.name || '(sem nome)')}</b> <span class="badge info">${esc(r.role ? api.ROLE_NAMES[r.role] : r.rawRole)}</span><br>
            <small class="muted">${esc([r.phone, r.email].filter(Boolean).join(' · '))}</small>
            ${r.problem ? `<br><small class="error-text">${esc(r.problem)}</small>` : ''}</span>
        </label>`).join('')}</div>
      <p id="progress" class="muted small" hidden></p>`,
    onSubmit: async (form) => {
      const chosen = [...form.querySelectorAll('[data-i]:checked')].map((c) => rows[Number(c.dataset.i)]);
      if (!chosen.length) { toast('Nenhuma pessoa marcada.', 'error'); return false; }
      const progress = form.querySelector('#progress');
      progress.hidden = false;
      const results = await api.importMembers(g.gid, chosen, (i, n) => { progress.textContent = `Importando ${i} de ${n}…`; });
      onDone();
      summary(results);
      return true;
    },
  });
  m.form.querySelector('#all').addEventListener('change', (e) => {
    m.form.querySelectorAll('[data-i]:not(:disabled)').forEach((c) => { c.checked = e.target.checked; });
  });
}

function summary(results) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  modal({
    title: 'Importação concluída',
    submitLabel: 'OK',
    body: `
      <p><b>${ok.length}</b> incluída${ok.length === 1 ? '' : 's'}${bad.length ? `, <b>${bad.length}</b> não incluída${bad.length === 1 ? '' : 's'}` : ''}.</p>
      ${bad.length ? `<div class="import-list">${bad.map((r) => `
        <div class="import-row bad"><span><b>${esc(r.row.name || r.row.email || r.row.phone)}</b><br>
          <small class="error-text">${esc(r.msg)}</small></span></div>`).join('')}</div>` : ''}`,
  });
}
