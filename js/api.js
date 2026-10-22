// Camada de dados do Welcomely: regras do app sobre um "store" (Firebase ou demonstração).
//
// Modelo no Firestore:
//   users/{uid}                         nome, e-mail, telefone, perfil (privado)
//   usersByEmail/{email}                uid, nome, perfil (para adicionar auxiliar pelo e-mail)
//   professionals/{uid}                 perfil público, regras, grade semanal, uids dos auxiliares
//     services/{id}                     tipos de atendimento (públicos)
//     blocks/{id}                       bloqueios (férias etc.)
//     days/{AAAA-MM-DD}                 horários ocupados do dia, sem dados pessoais (públicos)
//     team/{uid}                        dados dos auxiliares (só gestores)
//     clients/{id}                      clientes já atendidos (só gestores; sugestões)
//   appointments/{id}                   agendamentos (gestores do profissional e o próprio cliente)
//
// A reserva usa uma transação sobre o documento do dia: duas pessoas não conseguem pegar o mesmo horário.
import { firebaseConfig } from './firebase-config.js';
import {
  ACTIVE, addDays, busyIntervals, computeSlots, DATE_RE, DEFAULT_AVAILABILITY, DEFAULT_PROFILE, minutes, nowLocal,
  overlaps, STATUSES, TIME_RE, validateAvailability,
} from './data/logic.js';

export const DEMO = new URLSearchParams(location.search).has('demo') || !firebaseConfig.apiKey;
export const store = DEMO
  ? (await import('./data/store-demo.js')).createDemoStore()
  : (await import('./data/store-firebase.js')).createFirebaseStore(firebaseConfig);

const ROLES = ['profissional', 'cliente', 'auxiliar'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new AppError(message, status); };

const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');

// Sessão atual (preenchida por me())
let session = null;

function requireUid() {
  const uid = store.uid();
  if (!uid) fail('Faça login para continuar.', 401);
  return uid;
}

const isManager = (pid) => Boolean(session?.manages.some((p) => p.id === pid));

function requireManager(pid) {
  requireUid();
  if (!isManager(pid)) fail('Você não gerencia a agenda deste profissional.', 403);
}

function requireOwner(pid) {
  if (requireUid() !== pid || session?.user.role !== 'profissional') fail('Apenas o próprio profissional pode alterar isto.', 403);
}

async function getProf(pid) {
  const p = await store.get(`professionals/${pid}`);
  if (!p) fail('Profissional não encontrado.', 404);
  return p;
}

function profileOut(p) {
  return {
    id: p.id, name: p.name, title: p.title, bio: p.bio, location: p.location,
    requires_confirmation: p.requires_confirmation, min_notice_hours: p.min_notice_hours,
    max_days_ahead: p.max_days_ahead, cancel_notice_hours: p.cancel_notice_hours,
    slot_interval_min: p.slot_interval_min, public: p.public,
  };
}

const serviceOut = (s) => ({
  id: s.id, name: s.name, description: s.description || '', duration_min: s.duration_min, active: s.active !== false,
});

const apptOut = (a) => ({ ...a, starts_at: `${a.day}T${a.start}`, ends_at: `${a.day}T${a.end}` });
const sortByStart = (list) => list.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

// ------------------------------------------------------------------ contas

export async function register({ name, email, phone, password, role }) {
  name = text(name, 120);
  email = text(email, 200).toLowerCase();
  if (!name) fail('Informe o nome.');
  if (!EMAIL_RE.test(email)) fail('E-mail inválido.');
  if (String(password || '').length < 6) fail('A senha deve ter pelo menos 6 caracteres.');
  if (!ROLES.includes(role)) fail('Perfil inválido.');
  const uid = await store.signUp(email, password);
  await store.tx(async (t) => {
    t.set(`users/${uid}`, { name, email, phone: text(phone, 40), role, created_at: nowIso() });
    t.set(`usersByEmail/${email}`, { uid, name, role });
    if (role === 'profissional') {
      t.set(`professionals/${uid}`, { ...DEFAULT_PROFILE, name, availability: DEFAULT_AVAILABILITY, assistants: [] });
      t.set(`professionals/${uid}/services/${store.newId(`professionals/${uid}/services`)}`,
        { name: 'Atendimento', description: '', duration_min: 30, active: true });
    }
  });
}

export async function login({ email, password }) {
  await store.signIn(text(email, 200).toLowerCase(), String(password || ''));
}

export async function logout() {
  session = null;
  await store.signOut();
}

export async function resetPassword(email) {
  email = text(email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) fail('Informe o seu e-mail no campo acima.');
  await store.resetPassword(email);
}

export async function me() {
  const uid = requireUid();
  const user = await store.get(`users/${uid}`);
  if (!user) fail('Cadastro incompleto. Saia e cadastre-se de novo, ou fale com o suporte.', 401);
  const result = {
    user: { id: uid, name: user.name, email: user.email, phone: user.phone || '', role: user.role },
    manages: [],
    profile: null,
  };
  if (user.role === 'profissional') {
    const p = await getProf(uid);
    result.profile = profileOut(p);
    result.manages = [{ id: uid, name: p.name, title: p.title }];
  } else if (user.role === 'auxiliar') {
    const profs = await store.list('professionals', [['assistants', 'array-contains', uid]]);
    result.manages = profs.map((p) => ({ id: p.id, name: p.name, title: p.title })).sort(byName);
  }
  session = result;
  return result;
}

export async function updateMe({ name, phone, current_password, new_password }) {
  const uid = requireUid();
  name = text(name, 120);
  if (!name) fail('Informe o nome.');
  if (new_password) {
    if (String(new_password).length < 6) fail('A nova senha deve ter pelo menos 6 caracteres.');
    await store.changePassword(String(current_password || ''), String(new_password));
  }
  const { email, role } = session.user;
  await store.tx(async (t) => {
    t.update(`users/${uid}`, { name, phone: text(phone, 40) });
    t.update(`usersByEmail/${email}`, { name });
    if (role === 'profissional') t.update(`professionals/${uid}`, { name });
  });
}

// ------------------------------------------------------------ profissionais

export async function listProfessionals(q = '') {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  const rows = await store.list('professionals', [['public', '==', true]]);
  return rows
    .filter((p) => terms.every((t) => fold(`${p.name} ${p.title} ${p.location}`).includes(t)))
    .map(profileOut)
    .sort(byName);
}

export async function getProfessional(pid) {
  const [p, services] = await Promise.all([
    getProf(pid), store.list(`professionals/${pid}/services`, [['active', '==', true]])]);
  return { professional: profileOut(p), services: services.map(serviceOut).sort(byName) };
}

const PROFILE_INTS = { min_notice_hours: [0, 720], max_days_ahead: [1, 365], cancel_notice_hours: [0, 720], slot_interval_min: [5, 240] };

export async function updateProfile(pid, data) {
  requireOwner(pid);
  const updates = {};
  for (const k of ['title', 'location']) if (k in data) updates[k] = text(data[k], 200);
  if ('bio' in data) updates.bio = text(data.bio, 2000);
  for (const k of ['requires_confirmation', 'public']) if (k in data) updates[k] = Boolean(data[k]);
  for (const [k, [lo, hi]] of Object.entries(PROFILE_INTS)) {
    if (!(k in data)) continue;
    const v = Number(data[k]);
    if (!Number.isInteger(v) || v < lo || v > hi) fail(`Valor inválido: use de ${lo} a ${hi}.`);
    updates[k] = v;
  }
  await store.update(`professionals/${pid}`, updates);
  await me();
}

export async function slots(pid, serviceId, day) {
  if (!DATE_RE.test(day)) fail('Data inválida.');
  const [prof, service, dayDoc, blocks] = await Promise.all([
    getProf(pid), store.get(`professionals/${pid}/services/${serviceId}`),
    store.get(`professionals/${pid}/days/${day}`), store.list(`professionals/${pid}/blocks`)]);
  if (!service) fail('Serviço não encontrado.', 404);
  return computeSlots({ prof, duration: service.duration_min, day, dayDoc, blocks, enforce: !isManager(pid) });
}

// ---------------------------------------------------------------- serviços

export async function listServices(pid) {
  requireManager(pid);
  const rows = await store.list(`professionals/${pid}/services`);
  return rows.map(serviceOut).sort((a, b) => (b.active - a.active) || byName(a, b));
}

export async function saveService(pid, sid, data) {
  requireManager(pid);
  const duration = Number(data.duration_min);
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) fail('A duração deve ficar entre 5 e 600 minutos.');
  const values = { name: text(data.name, 120), description: text(data.description, 1000), duration_min: duration, active: data.active !== false };
  if (!values.name) fail('Informe o nome do serviço.');
  const id = sid || store.newId(`professionals/${pid}/services`);
  await store.set(`professionals/${pid}/services/${id}`, values);
}

/** Exclui; se já houver agendamentos com o serviço, só desativa (mantém o histórico). */
export async function deleteService(pid, sid) {
  requireManager(pid);
  const used = await store.list('appointments', [['professional_id', '==', pid], ['service_id', '==', sid]], 1);
  if (used.length) await store.update(`professionals/${pid}/services/${sid}`, { active: false });
  else await store.remove(`professionals/${pid}/services/${sid}`);
  return { deactivated: used.length > 0 };
}

// ------------------------------------------------- disponibilidade e bloqueios

export async function getAvailability(pid) {
  requireManager(pid);
  return (await getProf(pid)).availability || [];
}

export async function setAvailability(pid, rules) {
  requireManager(pid);
  await store.update(`professionals/${pid}`, { availability: validateAvailability(rules) });
}

export async function listBlocks(pid) {
  requireManager(pid);
  const now = nowLocal();
  const stamp = `${now.date}T${String(Math.floor(now.min / 60)).padStart(2, '0')}:${String(now.min % 60).padStart(2, '0')}`;
  const rows = await store.list(`professionals/${pid}/blocks`);
  return rows.filter((b) => b.ends_at > stamp).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

/** Cria o bloqueio e devolve quantos agendamentos ativos já existem no período. */
export async function createBlock(pid, { starts_at, ends_at, reason }) {
  requireManager(pid);
  if (!STAMP_RE.test(starts_at) || !STAMP_RE.test(ends_at)) fail('Datas inválidas.');
  if (starts_at >= ends_at) fail('O início do bloqueio deve ser antes do fim.');
  const lastDay = ends_at.slice(11) === '00:00' ? addDays(ends_at.slice(0, 10), -1) : ends_at.slice(0, 10);
  const days = [];
  for (let d = starts_at.slice(0, 10); d <= lastDay && days.length < 400; d = addDays(d, 1)) days.push(d);
  if (days.length >= 400) fail('O bloqueio pode ter no máximo um ano.');
  await store.set(`professionals/${pid}/blocks/${store.newId(`professionals/${pid}/blocks`)}`,
    { starts_at, ends_at, reason: text(reason, 200) });
  const block = [{ starts_at, ends_at }];
  const dayDocs = await Promise.all(days.map((d) => store.get(`professionals/${pid}/days/${d}`)));
  let conflicts = 0;
  dayDocs.forEach((doc, i) => {
    const blocked = busyIntervals(null, block, days[i]);
    conflicts += (doc?.busy || []).filter((b) => overlaps(minutes(b.s), minutes(b.e), blocked)).length;
  });
  return { conflicting_appointments: conflicts };
}

export async function deleteBlock(pid, bid) {
  requireManager(pid);
  await store.remove(`professionals/${pid}/blocks/${bid}`);
}

// ------------------------------------------------------------- auxiliares

export async function listAssistants(pid) {
  requireOwner(pid);
  return (await store.list(`professionals/${pid}/team`)).sort(byName);
}

export async function addAssistant(pid, email) {
  requireOwner(pid);
  email = text(email, 200).toLowerCase();
  const found = EMAIL_RE.test(email) ? await store.get(`usersByEmail/${email}`) : null;
  if (!found || found.role !== 'auxiliar') {
    fail('Não há conta de auxiliar com este e-mail. Peça para a pessoa se cadastrar como auxiliar.', 404);
  }
  await store.tx(async (t) => {
    const prof = await t.get(`professionals/${pid}`);
    t.update(`professionals/${pid}`, { assistants: [...new Set([...(prof.assistants || []), found.uid])] });
    t.set(`professionals/${pid}/team/${found.uid}`, { name: found.name, email });
  });
}

export async function removeAssistant(pid, aid) {
  requireOwner(pid);
  await store.tx(async (t) => {
    const prof = await t.get(`professionals/${pid}`);
    t.update(`professionals/${pid}`, { assistants: (prof.assistants || []).filter((id) => id !== aid) });
    t.remove(`professionals/${pid}/team/${aid}`);
  });
}

// ------------------------------------------------------------ agendamentos

/** Agendamentos de um profissional entre duas datas (inclusive). */
export async function agenda(pid, from, to) {
  requireManager(pid);
  const days = [];
  for (let d = from; d <= to && days.length < 62; d = addDays(d, 1)) days.push(d);
  const chunks = [];
  for (let i = 0; i < days.length; i += 30) chunks.push(days.slice(i, i + 30));
  const parts = await Promise.all(chunks.map((c) => store.list('appointments', [['professional_id', '==', pid], ['day', 'in', c]])));
  return sortByStart(parts.flat().map(apptOut));
}

/** Pedidos aguardando confirmação, de hoje em diante. */
export async function pending(pid) {
  requireManager(pid);
  const today = nowLocal().date;
  const rows = await store.list('appointments', [['professional_id', '==', pid], ['status', '==', 'pendente']]);
  return sortByStart(rows.filter((a) => a.day >= today).map(apptOut));
}

export async function clientSuggestions(pid, q) {
  requireManager(pid);
  const term = fold(q);
  const rows = await store.list(`professionals/${pid}/clients`);
  return rows
    .filter((c) => fold(`${c.name} ${c.phone} ${c.email}`).includes(term))
    .sort((a, b) => b.last.localeCompare(a.last))
    .slice(0, 20);
}

export async function myAppointments() {
  const uid = requireUid();
  const lists = [store.list('appointments', [['client_id', '==', uid]])];
  // Agendamentos feitos pela secretaria com o e-mail do cliente (exige e-mail confirmado)
  if (store.emailVerified() && store.email()) {
    lists.push(store.list('appointments', [['client_email', '==', store.email()]]).catch(() => []));
  }
  const byId = new Map((await Promise.all(lists)).flat().map((a) => [a.id, apptOut(a)]));
  return sortByStart([...byId.values()]).reverse();
}

const clientKey = (clientId, name, phone) => (clientId
  ? `u_${clientId}`
  : `${fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${String(phone).replace(/\D/g, '').slice(-8)}`);

export async function createAppointment(data) {
  const uid = requireUid();
  const pid = data.professional_id;
  const day = data.date;
  const time = data.time;
  if (!DATE_RE.test(day)) fail('Data inválida.');
  if (!TIME_RE.test(time || '')) fail('Horário inválido.');
  const [prof, service, blocks, dayDoc] = await Promise.all([
    getProf(pid), store.get(`professionals/${pid}/services/${data.service_id}`),
    store.list(`professionals/${pid}/blocks`), store.get(`professionals/${pid}/days/${day}`)]);
  if (!service || service.active === false) fail('Este serviço não está disponível.');
  const start = minutes(time);
  const end = start + service.duration_min;
  if (end > 24 * 60) fail('O atendimento precisa terminar no mesmo dia.');
  const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  const manager = isManager(pid);

  let client;
  let status;
  if (manager) {
    const name = text(data.client_name, 120);
    if (!name) fail('Informe o nome do cliente.');
    client = { client_id: null, client_name: name, client_phone: text(data.client_phone, 40), client_email: text(data.client_email, 200).toLowerCase() };
    status = 'confirmado';
    const now = nowLocal();
    if (data.fit_in) {  // encaixe: fora da grade, mas sem conflito (checado na transação)
      if (day < now.date || (day === now.date && start < now.min)) fail('Não é possível agendar no passado.');
    } else if (!computeSlots({ prof, duration: service.duration_min, day, dayDoc, blocks, enforce: false }).includes(time)) {
      fail('Horário indisponível. Para agendar fora da grade, marque como encaixe.', 409);
    }
  } else {
    const u = session.user;
    client = { client_id: uid, client_name: u.name, client_phone: u.phone, client_email: u.email };
    status = prof.requires_confirmation ? 'pendente' : 'confirmado';
    if (!computeSlots({ prof, duration: service.duration_min, day, dayDoc, blocks }).includes(time)) {
      fail('Este horário não está mais disponível. Escolha outro.', 409);
    }
  }

  const id = store.newId('appointments');
  const appt = {
    professional_id: pid, professional_name: prof.name, professional_title: prof.title || '',
    professional_location: prof.location || '',
    service_id: data.service_id, service_name: service.name, duration_min: service.duration_min,
    ...client, day, start: time, end: endTime, status, notes: text(data.notes, 1000),
    created_by: uid, created_at: nowIso(), updated_at: nowIso(),
  };
  const dayPath = `professionals/${pid}/days/${day}`;
  await store.tx(async (t) => {
    const fresh = await t.get(dayPath);
    if (overlaps(start, end, busyIntervals(fresh, blocks, day))) {
      fail('Este horário acabou de ser ocupado. Escolha outro.', 409);
    }
    t.set(`appointments/${id}`, appt);
    t.set(dayPath, { busy: [...(fresh?.busy || []), { id, s: time, e: endTime, c: client.client_id }] });
  });
  // Sugestão de cliente para as próximas vezes (não essencial)
  store.set(`professionals/${pid}/clients/${clientKey(client.client_id, client.client_name, client.client_phone)}`,
    { name: client.client_name, phone: client.client_phone, email: client.client_email, last: `${day}T${time}` })
    .catch(() => {});
  return apptOut({ id, ...appt });
}

/** Muda a situação, a anotação ou o horário (remarcar: só profissional/auxiliar). */
export async function updateAppointment(id, data) {
  const uid = requireUid();
  const a = await store.get(`appointments/${id}`);
  if (!a) fail('Agendamento não encontrado.', 404);
  const pid = a.professional_id;
  const manager = isManager(pid);
  const owner = a.client_id === uid || (a.client_email && a.client_email === store.email());
  if (!manager && !owner) fail('Agendamento não encontrado.', 404);
  if (a.status === 'cancelado') fail('Este agendamento já foi cancelado.');

  const updates = { updated_at: nowIso() };
  if (!manager) {
    if (Object.keys(data).some((k) => k !== 'status') || data.status !== 'cancelado') fail('Você só pode cancelar o seu agendamento.', 403);
    const prof = await getProf(pid);
    const now = nowLocal();
    const minutesLeft = (new Date(`${a.day}T${a.start}`) - new Date()) / 60000;
    if (a.status === 'confirmado' && minutesLeft < prof.cancel_notice_hours * 60 && a.day >= now.date) {
      fail(`Cancelamentos precisam de ${prof.cancel_notice_hours} h de antecedência. Entre em contato com o profissional.`, 403);
    }
  }
  if ('status' in data) {
    if (!STATUSES.includes(data.status)) fail('Situação inválida.');
    updates.status = data.status;
  }
  if ('notes' in data) updates.notes = text(data.notes, 1000);
  const moving = 'date' in data || 'time' in data;
  if (moving) {
    if (!DATE_RE.test(data.date || '') || !TIME_RE.test(data.time || '')) fail('Data ou horário inválido.');
    const end = minutes(data.time) + a.duration_min;
    if (end > 24 * 60) fail('O atendimento precisa terminar no mesmo dia.');
    updates.day = data.date;
    updates.start = data.time;
    updates.end = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  }
  const blocks = moving ? await store.list(`professionals/${pid}/blocks`) : [];
  const oldPath = `professionals/${pid}/days/${a.day}`;
  const newPath = moving ? `professionals/${pid}/days/${updates.day}` : oldPath;
  await store.tx(async (t) => {
    const oldDoc = await t.get(oldPath);
    const newDoc = newPath === oldPath ? oldDoc : await t.get(newPath);
    let oldBusy = (oldDoc?.busy || []).filter((b) => b.id !== id);
    const freed = updates.status === 'cancelado';
    if (moving) {
      const target = newPath === oldPath ? oldBusy : (newDoc?.busy || []);
      if (overlaps(minutes(updates.start), minutes(updates.end), busyIntervals({ busy: target }, blocks, updates.day))) {
        fail('Já existe um agendamento ou bloqueio neste horário.', 409);
      }
      const entry = { id, s: updates.start, e: updates.end, c: a.client_id ?? null };
      if (newPath === oldPath) oldBusy = [...oldBusy, entry];
      else t.set(newPath, { busy: [...target, entry] });
    } else if (!freed) {
      oldBusy = oldDoc?.busy || [];
    }
    t.update(`appointments/${id}`, updates);
    if (freed || moving) t.set(oldPath, { busy: oldBusy });
  });
  return apptOut({ ...a, ...updates, id });
}

export const isActive = (status) => ACTIVE.includes(status);
