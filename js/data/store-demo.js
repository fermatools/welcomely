// Armazenamento de demonstração: sem Firebase, dados guardados só neste navegador (localStorage).
// Mesma interface de store-firebase.js. Usado quando o Firebase não está configurado ou com ?demo.
import { addDays, DEFAULT_AVAILABILITY, DEFAULT_PROFILE, isoDate, minutes } from './logic.js';

const KEY = 'welcomely-demo-v1';
export const DEMO_PASSWORD = 'demo123';
export const DEMO_ACCOUNTS = [
  ['ana@demo.welcomely', 'Profissional (psicóloga)'],
  ['joao@demo.welcomely', 'Profissional (padre)'],
  ['maria@demo.welcomely', 'Auxiliar (secretária)'],
  ['carlos@demo.welcomely', 'Cliente'],
];

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const randomId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);

function seed() {
  const docs = {};
  const accounts = {};
  const now = new Date().toISOString();
  const user = (uid, name, email, role, phone = '') => {
    accounts[email] = { uid, password: DEMO_PASSWORD };
    docs[`users/${uid}`] = { name, email, phone, role, created_at: now };
    docs[`usersByEmail/${email}`] = { uid, name, role };
  };
  const prof = (uid, name, extra, services) => {
    docs[`professionals/${uid}`] = {
      ...DEFAULT_PROFILE, ...extra, name, availability: DEFAULT_AVAILABILITY, assistants: ['u-maria'],
    };
    services.forEach(([sid, sname, duration, description = '']) => {
      docs[`professionals/${uid}/services/${sid}`] = { name: sname, description, duration_min: duration, active: true };
    });
    docs[`professionals/${uid}/team/u-maria`] = { name: 'Maria Oliveira', email: 'maria@demo.welcomely' };
  };

  user('u-ana', 'Dra. Ana Souza', 'ana@demo.welcomely', 'profissional', '(21) 98888-0001');
  user('u-joao', 'Pe. João Lima', 'joao@demo.welcomely', 'profissional');
  user('u-maria', 'Maria Oliveira', 'maria@demo.welcomely', 'auxiliar', '(21) 97777-0003');
  user('u-carlos', 'Carlos Pereira', 'carlos@demo.welcomely', 'cliente', '(21) 96666-0004');
  prof('u-ana', 'Dra. Ana Souza', {
    title: 'Psicóloga clínica', location: 'Niterói — Icaraí', slot_interval_min: 60,
    bio: 'Atendimento de adultos e adolescentes. Terapia cognitivo-comportamental.',
  }, [['s-terapia', 'Sessão de terapia', 50], ['s-primeira', 'Primeira consulta', 60, 'Entrevista inicial']]);
  prof('u-joao', 'Pe. João Lima', {
    title: 'Pároco', location: 'Paróquia São José', requires_confirmation: false,
    bio: 'Atendimento pastoral, confissões e orientação espiritual.',
  }, [['s-pastoral', 'Atendimento pastoral', 30], ['s-confissao', 'Confissão', 15],
    ['s-batismo', 'Preparação para batismo', 60, 'Conversa com pais e padrinhos']]);

  // Agendamentos no próximo dia útil
  let day = addDays(isoDate(new Date()), 1);
  while ([0, 6].includes(new Date(`${day}T12:00`).getDay())) day = addDays(day, 1);
  const profs = {
    'u-ana': ['Dra. Ana Souza', 'Psicóloga clínica', 'Niterói — Icaraí', { 's-terapia': 'Sessão de terapia' }],
    'u-joao': ['Pe. João Lima', 'Pároco', 'Paróquia São José', { 's-pastoral': 'Atendimento pastoral' }],
  };
  const appts = [
    ['a1', 'u-ana', 's-terapia', 'u-carlos', 'Carlos Pereira', '(21) 96666-0004', 'carlos@demo.welcomely', '09:00', '09:50', 'pendente'],
    ['a2', 'u-ana', 's-terapia', null, 'Beatriz Santos', '(21) 95555-1234', '', '10:00', '10:50', 'confirmado'],
    ['a3', 'u-ana', 's-terapia', null, 'Rafael Costa', '', '', '14:00', '14:50', 'confirmado'],
    ['a4', 'u-joao', 's-pastoral', 'u-carlos', 'Carlos Pereira', '(21) 96666-0004', 'carlos@demo.welcomely', '15:00', '15:30', 'confirmado'],
    ['a5', 'u-joao', 's-pastoral', null, 'Família Almeida', '(21) 94444-5678', '', '16:00', '16:30', 'confirmado'],
  ];
  for (const [id, pid, sid, cid, name, phone, email, s, e, status] of appts) {
    const [pname, ptitle, ploc, services] = profs[pid];
    docs[`appointments/${id}`] = {
      professional_id: pid, professional_name: pname, professional_title: ptitle, professional_location: ploc,
      service_id: sid, service_name: services[sid], duration_min: minutes(e) - minutes(s),
      client_id: cid, client_name: name, client_phone: phone, client_email: email,
      day, start: s, end: e, status, notes: '', created_by: 'u-maria', created_at: now, updated_at: now,
    };
    const dayPath = `professionals/${pid}/days/${day}`;
    docs[dayPath] = { busy: [...(docs[dayPath]?.busy || []), { id, s, e, c: cid }] };
    const clientKey = cid ? `u_${cid}` : name.toLowerCase().replace(/\W+/g, '-');
    docs[`professionals/${pid}/clients/${clientKey}`] = { name, phone, email, last: `${day}T${s}` };
  }
  return { docs, accounts, session: null };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* armazenamento indisponível */ }
  return seed();
}

export function createDemoStore() {
  let db = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* ignora */ } };
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(db.session));
  const delay = () => new Promise((r) => setTimeout(r, 60));   // simula rede

  const matches = (data, [field, op, value]) => {
    const v = data[field];
    if (op === '==') return v === value;
    if (op === 'in') return value.includes(v);
    if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
    throw new Error(`Operador não suportado na demonstração: ${op}`);
  };

  const ops = {
    get: (path) => (db.docs[path] ? { id: path.split('/').pop(), ...clone(db.docs[path]) } : null),
    set: (path, data, merge = false) => { db.docs[path] = clone(merge ? { ...db.docs[path], ...data } : data); },
    update: (path, data) => {
      if (!db.docs[path]) throw new Error('Registro não encontrado.');
      db.docs[path] = { ...db.docs[path], ...clone(data) };
    },
    remove: (path) => { delete db.docs[path]; },
  };

  return {
    demo: true,
    ready: async () => {},
    onAuthChange: (fn) => listeners.add(fn),
    uid: () => db.session,
    email: () => Object.keys(db.accounts).find((e) => db.accounts[e].uid === db.session) ?? null,
    emailVerified: () => true,

    async signUp(email, password) {
      await delay();
      if (db.accounts[email]) throw new Error('Já existe uma conta com este e-mail.');
      if (password.length < 6) throw new Error('A senha deve ter pelo menos 6 caracteres.');
      const uid = `u-${randomId()}`;
      db.accounts[email] = { uid, password };
      db.session = uid;
      save();
      return uid;
    },
    async signIn(email, password) {
      await delay();
      const acc = db.accounts[email];
      if (!acc || acc.password !== password) throw new Error('E-mail ou senha incorretos.');
      db.session = acc.uid;
      save();
      notify();
    },
    async signOut() { db.session = null; save(); notify(); },
    async resetPassword() {
      throw new Error('Na demonstração não há envio de e-mail. A senha das contas de exemplo é demo123.');
    },
    async changePassword(current, next) {
      const email = this.email();
      if (db.accounts[email].password !== current) throw new Error('Senha atual incorreta.');
      db.accounts[email].password = next;
      save();
    },

    newId: () => randomId(),
    async get(path) { await delay(); return ops.get(path); },
    async list(colPath, filters = [], max = null) {
      await delay();
      const depth = colPath.split('/').length + 1;
      const rows = Object.keys(db.docs)
        .filter((p) => p.startsWith(`${colPath}/`) && p.split('/').length === depth)
        .map((p) => ops.get(p))
        .filter((d) => filters.every((f) => matches(d, f)));
      return max ? rows.slice(0, max) : rows;
    },
    async set(path, data, merge) { await delay(); ops.set(path, data, merge); save(); },
    async update(path, data) { await delay(); ops.update(path, data); save(); },
    async remove(path) { await delay(); ops.remove(path); save(); },
    async tx(fn) {
      await delay();
      const backup = clone(db.docs);
      try {
        const result = await fn(ops);
        save();
        return result;
      } catch (err) {
        db.docs = backup;
        throw err;
      }
    },

    reset() { db = seed(); save(); },
  };
}
