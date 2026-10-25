// Camada de dados do Welcomely: regras do app sobre um "store" (Firebase ou demonstração).
//
// Perfis: admin (cadastra qualquer um, cria grupos), profissional/atendente (cadastra auxiliares e
// clientes nos seus grupos), auxiliar (cadastra clientes; gerencia a agenda dos atendentes do grupo), cliente.
//
// Modelo no Firestore:
//   users/{uid}                    nome, e-mail, telefone, perfil (privado: a própria pessoa e o admin)
//   usersByEmail/{email}           uid, nome, perfil (para achar uma conta pelo e-mail ao cadastrar)
//   groups/{gid}                   nome do grupo (o id serve de convite)
//   memberships/{gid}_{uid}        participação: perfil, nome, contato, nome do grupo
//   staff/{pid}_{auxUid}           grupos em que o auxiliar e o atendente estão juntos (dá acesso à agenda)
//   professionals/{uid}            perfil do atendente, regras e grade semanal
//     services/{id} · blocks/{id} · days/{AAAA-MM-DD} (horários ocupados, sem nomes) · clients/{id}
//   appointments/{id}              agendamentos
//
// A reserva usa uma transação sobre o documento do dia: duas pessoas não conseguem pegar o mesmo horário.
import { ADMIN_EMAIL_SHA256 } from './config.js';
import { firebaseConfig } from './firebase-config.js';
import {
  addDays, busyIntervals, computeSlots, DATE_RE, DEFAULT_AVAILABILITY, DEFAULT_PROFILE, minutes, nowLocal,
  overlaps, STATUSES, TIME_RE, upgradeRules, validateAvailability,
} from './data/logic.js';

export const DEMO = new URLSearchParams(location.search).has('demo') || !firebaseConfig.apiKey;
export const store = DEMO
  ? (await import('./data/store-demo.js')).createDemoStore()
  : (await import('./data/store-firebase.js')).createFirebaseStore(firebaseConfig);

export const ROLE_NAMES = { admin: 'Administrador', profissional: 'Atendente', auxiliar: 'Auxiliar', cliente: 'Cliente' };
// Quem cada perfil pode cadastrar num grupo
export const CAN_ADD = {
  admin: ['profissional', 'auxiliar', 'cliente'],
  profissional: ['auxiliar', 'cliente'],
  auxiliar: ['cliente'],
  cliente: [],
};
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new AppError(message, status); };

const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');
async function isAdminEmail(email) {
  if (!crypto.subtle) return false;   // só existe em HTTPS/localhost
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') === ADMIN_EMAIL_SHA256;
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Sessão atual (preenchida por me())
let session = null;

function requireUid() {
  const uid = store.uid();
  if (!uid) fail('Faça login para continuar.', 401);
  return uid;
}

const role = () => session?.user.role;
const isAdmin = () => role() === 'admin';
const isManager = (pid) => Boolean(session?.manages.some((p) => p.id === pid));
/** Papel do usuário atual no grupo (admin vale como gestor de todos). */
const roleIn = (gid) => (isAdmin() ? 'admin' : session?.groups.find((g) => g.gid === gid)?.role ?? null);

function requireManager(pid) {
  requireUid();
  if (!isManager(pid)) fail('Você não gerencia a agenda deste atendente.', 403);
}

function requireOwner(pid) {
  if (requireUid() !== pid || role() !== 'profissional') fail('Apenas o próprio atendente pode alterar isto.', 403);
}

async function getProf(pid) {
  const p = await store.get(`professionals/${pid}`);
  if (!p) fail('Atendente não encontrado.', 404);
  return p;
}

function profileOut(p) {
  return {
    id: p.id, name: p.name, title: p.title, bio: p.bio, location: p.location,
    requires_confirmation: p.requires_confirmation, min_notice_hours: p.min_notice_hours,
    max_days_ahead: p.max_days_ahead, cancel_notice_hours: p.cancel_notice_hours,
    slot_interval_min: p.slot_interval_min,
  };
}

const serviceOut = (s) => ({
  id: s.id, name: s.name, description: s.description || '', duration_min: s.duration_min, active: s.active !== false,
});

const apptOut = (a) => ({ ...a, starts_at: `${a.day}T${a.start}`, ends_at: `${a.day}T${a.end}` });
const sortByStart = (list) => list.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

// ------------------------------------------------------------------ contas

/** Grupo de um convite (leitura pública: só o nome). */
export async function getInvite(gid) {
  const g = await store.get(`groups/${gid}`);
  if (!g) fail('Convite inválido ou grupo inexistente.', 404);
  return { gid, name: g.name };
}

/**
 * Cadastro feito pela própria pessoa: cliente que chegou pelo link de convite de um grupo,
 * ou o administrador (e-mail identificado pelo hash em config.js).
 */
export async function register({ name, email, phone, password, invite }) {
  name = text(name, 120);
  email = text(email, 200).toLowerCase();
  if (!name) fail('Informe o nome.');
  if (!EMAIL_RE.test(email)) fail('E-mail inválido.');
  if (String(password || '').length < 6) fail('A senha deve ter pelo menos 6 caracteres.');
  const asAdmin = await isAdminEmail(email);
  const group = invite ? await getInvite(invite) : null;
  if (!asAdmin && !group) fail('O cadastro é feito por convite. Peça o link ao seu atendente.');
  const userRole = asAdmin ? 'admin' : 'cliente';
  const uid = await store.signUp(email, password);
  phone = text(phone, 40);
  await store.tx(async (t) => {
    t.set(`users/${uid}`, { name, email, phone, role: userRole, created_by: uid, created_at: nowIso() });
    t.set(`usersByEmail/${email}`, { uid, name, role: userRole, created_by: uid });
    if (group && !asAdmin) {
      t.set(`memberships/${group.gid}_${uid}`, {
        gid: group.gid, uid, role: 'cliente', name, email, phone, group_name: group.name, added_by: uid, added_at: nowIso(),
      });
    }
  });
}

export async function login({ email, password }) {
  await store.signIn(text(email, 200).toLowerCase(), String(password || ''));
}

/**
 * Entrar com a conta Google. Quem já foi cadastrado com esse e-mail entra na mesma conta.
 * Na primeira vez, só cria a conta pelo link de convite (cliente) ou se for o administrador.
 */
export async function loginWithGoogle(invite) {
  const g = await store.signInWithGoogle();
  if (await store.get(`users/${g.uid}`)) return;
  const email = g.email;
  const asAdmin = await isAdminEmail(email.toLowerCase());
  const group = invite ? await getInvite(invite).catch(() => null) : null;
  if (!asAdmin && !group) {
    if (g.isNew) await store.deleteCurrentUser().catch(() => {});
    await store.signOut();
    fail('Esta conta Google ainda não tem acesso ao Welcomely. O acesso é por convite: peça o link ao seu atendente.', 403);
  }
  const role = asAdmin ? 'admin' : 'cliente';
  const name = text(g.name || email.split('@')[0], 120);
  await store.tx(async (t) => {
    t.set(`users/${g.uid}`, { name, email, phone: '', role, created_by: g.uid, created_at: nowIso() });
    t.set(`usersByEmail/${email}`, { uid: g.uid, name, role, created_by: g.uid });
    if (group && !asAdmin) {
      t.set(`memberships/${group.gid}_${g.uid}`, {
        gid: group.gid, uid: g.uid, role: 'cliente', name, email, phone: '', group_name: group.name, added_by: g.uid, added_at: nowIso(),
      });
    }
  });
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

export const resendVerification = () => store.sendVerification();

export async function me() {
  const uid = requireUid();
  let user = await store.get(`users/${uid}`);
  if (!user) fail('Cadastro incompleto. Fale com quem cadastrou você.', 401);
  if (user.role === 'admin' && !store.emailVerified()) await store.refreshUser();
  const memberships = await store.list('memberships', [['uid', '==', uid]]);
  const result = {
    user: { id: uid, name: user.name, email: user.email, phone: user.phone || '', role: user.role },
    groups: memberships.map((m) => ({ gid: m.gid, name: m.group_name, role: m.role })).sort(byName),
    manages: [],
    profile: null,
    // O admin só vale com o e-mail confirmado (as regras do Firestore exigem isso)
    needsVerification: user.role === 'admin' && !store.emailVerified(),
  };
  if (user.role === 'profissional') {
    const p = await getProf(uid);
    result.profile = profileOut(p);
    result.manages = [{ id: uid, name: p.name, title: p.title }];
  } else if (user.role === 'auxiliar') {
    const links = (await store.list('staff', [['aux', '==', uid]])).filter((s) => s.gids?.length);
    const profs = await Promise.all(links.map((s) => store.get(`professionals/${s.pid}`)));
    result.manages = profs.filter(Boolean).map((p) => ({ id: p.id, name: p.name, title: p.title })).sort(byName);
  } else if (user.role === 'admin' && !result.needsVerification) {
    const profs = await store.list('professionals');
    result.manages = profs.map((p) => ({ id: p.id, name: p.name, title: p.title })).sort(byName);
  }
  session = result;
  return result;
}

export async function updateMe({ name, phone, current_password, new_password }) {
  const uid = requireUid();
  name = text(name, 120);
  phone = text(phone, 40);
  if (!name) fail('Informe o nome.');
  if (new_password) {
    if (String(new_password).length < 6) fail('A nova senha deve ter pelo menos 6 caracteres.');
    await store.changePassword(String(current_password || ''), String(new_password));
  }
  const { email } = session.user;
  await store.tx(async (t) => {
    t.update(`users/${uid}`, { name, phone });
    t.update(`usersByEmail/${email}`, { name });
    if (role() === 'profissional') t.update(`professionals/${uid}`, { name });
    for (const g of session.groups) t.update(`memberships/${g.gid}_${uid}`, { name, phone });
  });
}

// ---------------------------------------------------------------- grupos

/** Grupos visíveis: todos para o admin; os seus para os demais. */
export async function listGroups() {
  requireUid();
  if (isAdmin()) {
    return (await store.list('groups')).map((g) => ({ gid: g.id, name: g.name, role: 'admin' })).sort(byName);
  }
  return session.groups;
}

export async function createGroup(name) {
  requireUid();
  if (!isAdmin()) fail('Apenas o administrador cria grupos.', 403);
  name = text(name, 120);
  if (!name) fail('Informe o nome do grupo.');
  const gid = store.newId('groups');
  await store.set(`groups/${gid}`, { name, created_at: nowIso() });
  return gid;
}

/** Membros de um grupo (para atendente, auxiliar e admin). */
export async function groupMembers(gid) {
  const r = roleIn(gid);
  if (!['admin', 'profissional', 'auxiliar'].includes(r)) fail('Você não gerencia este grupo.', 403);
  const [group, members] = await Promise.all([store.get(`groups/${gid}`), store.list('memberships', [['gid', '==', gid]])]);
  if (!group) fail('Grupo não encontrado.', 404);
  return { gid, name: group.name, myRole: r, canAdd: CAN_ADD[r], members: members.sort(byName) };
}

/**
 * Pessoas que já têm conta e podem ser adicionadas ao grupo: todas as contas para o admin; para atendente e
 * auxiliar, as pessoas dos outros grupos que eles gerenciam. Só perfis que o usuário pode cadastrar.
 */
export async function knownPeople(gid) {
  const r = roleIn(gid);
  const allowed = CAN_ADD[r || 'cliente'] || [];
  if (!allowed.length) return [];
  const inGroup = new Set((await store.list('memberships', [['gid', '==', gid]])).map((m) => m.uid));
  let people;
  const fromMember = (m) => ({ uid: m.uid, name: m.name, email: m.email || '', phone: m.phone || '', role: m.role, no_account: Boolean(m.no_account) });
  if (isAdmin()) {
    const [users, contacts] = await Promise.all([store.list('users'), store.list('memberships', [['no_account', '==', true]])]);
    people = users.map((u) => ({ uid: u.id, name: u.name, email: u.email, phone: u.phone || '', role: u.role, no_account: false }))
      .concat(contacts.map(fromMember));
  } else {
    const others = session.groups.filter((g) => g.gid !== gid && ['profissional', 'auxiliar'].includes(g.role));
    const lists = await Promise.all(others.map((g) => store.list('memberships', [['gid', '==', g.gid]])));
    people = lists.flat().map(fromMember);
  }
  const seen = new Set();
  return people
    .filter((p) => allowed.includes(p.role) && !inGroup.has(p.uid) && !seen.has(p.uid) && seen.add(p.uid))
    .sort(byName);
}

/** Atualiza o vínculo auxiliar ↔ atendente de um grupo (acrescenta ou retira o grupo da lista). */
async function linkStaff(pid, aux, gid, add) {
  await store.tx(async (t) => {
    const path = `staff/${pid}_${aux}`;
    const cur = await t.get(path);
    const gids = new Set(cur?.gids || []);
    if (add === gids.has(gid)) return;
    if (add) gids.add(gid); else gids.delete(gid);
    t.set(path, { pid, aux, gids: [...gids] });
  });
}

/**
 * Cadastra uma pessoa num grupo. Se ainda não houver conta com o e-mail, cria a conta e a pessoa recebe um
 * e-mail para criar a própria senha. Devolve { created } (true = conta nova).
 */
export async function addMember(gid, { name, email, phone, role: newRole, no_account: noAccount, cid }) {
  const uid0 = requireUid();
  const r = roleIn(gid);
  if (!CAN_ADD[r || 'cliente']?.includes(newRole)) fail('Você não pode cadastrar este perfil neste grupo.', 403);
  name = text(name, 120);
  email = text(email, 200).toLowerCase();
  phone = text(phone, 40);
  const group = await store.get(`groups/${gid}`);
  if (!group) fail('Grupo não encontrado.', 404);

  // Cliente sem conta: só nome e contato (telefone ou e-mail), para a secretaria agendar.
  // Se o e-mail já tiver conta, adiciona a conta em vez disso.
  const existingByEmail = email && EMAIL_RE.test(email) ? await store.get(`usersByEmail/${email}`) : null;
  if (newRole === 'cliente' && noAccount && !existingByEmail) {
    if (!name) fail('Informe o nome.');
    if (!phone && !email) fail('Informe o telefone ou o e-mail do cliente.');
    if (email && !EMAIL_RE.test(email)) fail('E-mail inválido.');
    const members = await store.list('memberships', [['gid', '==', gid]]);
    const dup = members.find((m) => (email && m.email === email) || (!email && phone && m.phone === phone && m.no_account));
    if (dup) fail(`${dup.name} já está no grupo com este ${email ? 'e-mail' : 'telefone'}.`);
    const contactId = cid || `c_${store.newId('memberships')}`;
    await store.set(`memberships/${gid}_${contactId}`, {
      gid, uid: contactId, role: 'cliente', no_account: true, name, email, phone,
      group_name: group.name, added_by: uid0, added_at: nowIso(),
    });
    return { created: false, contact: true };
  }
  if (!EMAIL_RE.test(email)) fail('E-mail inválido.');

  let uid;
  let created = false;
  const existing = existingByEmail;
  if (existing) {
    if (existing.role !== newRole) {
      fail(`Este e-mail já tem conta como ${ROLE_NAMES[existing.role].toLowerCase()}. Cada conta tem um só perfil.`);
    }
    uid = existing.uid;
    name = existing.name;   // a conta já existe: vale o nome que a pessoa usa
    if (await store.get(`memberships/${gid}_${uid}`)) fail('Esta pessoa já está no grupo.');
  } else {
    if (!name) fail('Informe o nome.');
    uid = await store.createAccount(email);
    created = true;
  }

  const members = await store.list('memberships', [['gid', '==', gid]]);
  await store.tx(async (t) => {
    if (created) {
      t.set(`users/${uid}`, { name, email, phone, role: newRole, created_by: uid0, created_at: nowIso() });
      t.set(`usersByEmail/${email}`, { uid, name, role: newRole, created_by: uid0 });
      if (newRole === 'profissional') {
        t.set(`professionals/${uid}`, { ...DEFAULT_PROFILE, name, availability: DEFAULT_AVAILABILITY });
        t.set(`professionals/${uid}/services/${store.newId(`professionals/${uid}/services`)}`,
          { name: 'Atendimento', description: '', duration_min: 30, active: true });
      }
    }
    t.set(`memberships/${gid}_${uid}`, {
      gid, uid, role: newRole, name, email, phone, group_name: group.name, added_by: uid0, added_at: nowIso(),
    });
  });
  // Auxiliar passa a gerenciar os atendentes do grupo (e vice-versa)
  if (newRole === 'auxiliar') {
    for (const m of members.filter((x) => x.role === 'profissional')) await linkStaff(m.uid, uid, gid, true);
  } else if (newRole === 'profissional') {
    for (const m of members.filter((x) => x.role === 'auxiliar')) await linkStaff(uid, m.uid, gid, true);
  }
  if (newRole === 'cliente') {
    const contacts = members.filter((m) => m.no_account && m.email === email);
    for (const c of contacts) await store.remove(`memberships/${gid}_${c.uid}`);
  }
  if (created && !store.demo) await store.resetPassword(email);
  return { created };
}

export async function removeMember(gid, uid) {
  requireUid();
  const m = await store.get(`memberships/${gid}_${uid}`);
  if (!m) fail('Esta pessoa não está no grupo.', 404);
  if (!CAN_ADD[roleIn(gid) || 'cliente']?.includes(m.role)) fail('Você não pode retirar esta pessoa do grupo.', 403);
  const members = await store.list('memberships', [['gid', '==', gid]]);
  if (m.role === 'auxiliar') {
    for (const p of members.filter((x) => x.role === 'profissional')) await linkStaff(p.uid, uid, gid, false);
  } else if (m.role === 'profissional') {
    for (const a of members.filter((x) => x.role === 'auxiliar')) await linkStaff(uid, a.uid, gid, false);
  }
  await store.remove(`memberships/${gid}_${uid}`);
}

/** Cliente já logado que abriu o link de convite de outro grupo. */
export async function joinGroup(gid) {
  const uid = requireUid();
  if (role() !== 'cliente') fail('O convite é para clientes. Peça a quem administra o grupo para incluir você.');
  const group = await getInvite(gid);
  if (session.groups.some((g) => g.gid === gid)) return;
  const u = session.user;
  await store.set(`memberships/${gid}_${uid}`, {
    gid, uid, role: 'cliente', name: u.name, email: u.email, phone: u.phone, group_name: group.name, added_by: uid, added_at: nowIso(),
  });
}

// ------------------------------------------------------------ atendentes

/** Atendentes dos grupos do cliente (cada um com os grupos em comum). */
export async function listProfessionals(q = '') {
  requireUid();
  const terms = fold(q).split(/\s+/).filter(Boolean);
  const groups = isAdmin() ? await listGroups() : session.groups;
  const lists = await Promise.all(groups.map((g) => store.list('memberships', [['gid', '==', g.gid], ['role', '==', 'profissional']])));
  const byPid = new Map();
  lists.flat().forEach((m) => {
    const entry = byPid.get(m.uid) || { pid: m.uid, groups: [] };
    entry.groups.push(m.group_name);
    byPid.set(m.uid, entry);
  });
  const profs = await Promise.all([...byPid.keys()].map((pid) => store.get(`professionals/${pid}`)));
  return profs.filter(Boolean)
    .map((p) => ({ ...profileOut(p), groups: byPid.get(p.id).groups }))
    .filter((p) => terms.every((t) => fold(`${p.name} ${p.title} ${p.location} ${p.groups.join(' ')}`).includes(t)))
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
  if ('requires_confirmation' in data) updates.requires_confirmation = Boolean(data.requires_confirmation);
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
  return upgradeRules((await getProf(pid)).availability);
}

export async function setAvailability(pid, rules) {
  requireManager(pid);
  await store.update(`professionals/${pid}`, { availability: validateAvailability(rules) });
}

export async function listBlocks(pid) {
  requireManager(pid);
  const now = nowLocal();
  const stamp = `${now.date}T${hhmm(now.min)}`;
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

// ------------------------------------------------------------ agendamentos

/** Agendamentos de um atendente entre duas datas (inclusive). */
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

/** Clientes para sugerir ao agendar: os dos grupos do usuário e os já atendidos sem conta. */
export async function clientSuggestions(pid, q) {
  requireManager(pid);
  const term = fold(q);
  const staffGroups = isAdmin() ? [] : session.groups.filter((g) => g.role !== 'cliente');
  const [past, ...groupLists] = await Promise.all([
    store.list(`professionals/${pid}/clients`),
    ...staffGroups.map((g) => store.list('memberships', [['gid', '==', g.gid], ['role', '==', 'cliente']])),
  ]);
  const seen = new Set();
  return [...groupLists.flat().map((m) => ({ name: m.name, phone: m.phone, email: m.email, last: '' })), ...past]
    .filter((c) => fold(`${c.name} ${c.phone} ${c.email}`).includes(term))
    .filter((c) => { const k = c.email || `${c.name}|${c.phone}`; if (seen.has(k)) return false; seen.add(k); return true; })
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
  const manager = isManager(pid);

  let client;
  let status;
  let gid = '';
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
    // O cliente só agenda com atendentes de um grupo em comum
    const shared = await Promise.all(session.groups.map((g) => store.get(`memberships/${g.gid}_${pid}`)));
    gid = session.groups[shared.findIndex((m) => m && m.role === 'profissional')]?.gid;
    if (!gid) fail('Você não faz parte de nenhum grupo deste atendente.', 403);
    const u = session.user;
    client = { client_id: uid, client_name: u.name, client_phone: u.phone, client_email: u.email };
    status = prof.requires_confirmation ? 'pendente' : 'confirmado';
    if (!computeSlots({ prof, duration: service.duration_min, day, dayDoc, blocks }).includes(time)) {
      fail('Este horário não está mais disponível. Escolha outro.', 409);
    }
  }

  const id = store.newId('appointments');
  const endTime = hhmm(end);
  const appt = {
    gid, professional_id: pid, professional_name: prof.name, professional_title: prof.title || '',
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
  // Sugestão de cliente sem conta para as próximas vezes (não essencial)
  if (manager && !client.client_email) {
    store.set(`professionals/${pid}/clients/${clientKey(null, client.client_name, client.client_phone)}`,
      { name: client.client_name, phone: client.client_phone, email: '', last: `${day}T${time}` }).catch(() => {});
  }
  return apptOut({ id, ...appt });
}

/** Muda a situação, a anotação ou o horário (remarcar: só atendente/auxiliar). */
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
    const minutesLeft = (new Date(`${a.day}T${a.start}`) - new Date()) / 60000;
    if (a.status === 'confirmado' && minutesLeft < prof.cancel_notice_hours * 60 && minutesLeft > 0) {
      fail(`Cancelamentos precisam de ${prof.cancel_notice_hours} h de antecedência. Entre em contato com o atendente.`, 403);
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
    updates.end = hhmm(end);
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
    }
    t.update(`appointments/${id}`, updates);
    if (freed || moving) t.set(oldPath, { busy: oldBusy });
  });
  return apptOut({ ...a, ...updates, id });
}
