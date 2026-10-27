// Camada de dados do Welcomely: regras do app sobre um "store" (Firebase ou demonstração).
//
// Perfis: admin (cadastra qualquer um, cria grupos), profissional/atendente (cadastra auxiliares e
// clientes nos seus grupos), auxiliar (cadastra clientes; gerencia a agenda dos atendentes do grupo), cliente.
//
// Modelo no Firestore:
//   users/{uid}                    nome, e-mail, telefone, perfil (privado: a própria pessoa e o admin)
//   usersByEmail/{email}           uid, nome, perfil (para achar uma conta pelo e-mail ao cadastrar)
//   groups/{gid}                   nome do grupo (o id serve de convite)
//   memberships/{gid}_{uid}        participação: perfil, nome, nome do grupo (SEM telefone/e-mail)
//   contacts/{gid}_{uid}           telefone e e-mail da pessoa no grupo (não legível pelo auxiliar "só agenda")
//   staff/{pid}_{auxUid}           grupos em que o auxiliar e o atendente estão juntos (dá acesso à agenda)
//   fullstaff/{pid}_{auxUid}       idem, só os grupos em que o auxiliar é "secretaria" (dá acesso aos contatos)
//   professionals/{uid}            perfil do atendente, regras e grade semanal
//     services/{id} · blocks/{id} · days/{AAAA-MM-DD} (horários ocupados, sem nomes) · clients/{id}
//   appointments/{id}              agendamentos (nome do cliente; contato só por referência)
//   apptContacts/{id}              telefone/e-mail digitados num agendamento (mesma proteção de contacts)
//   meta/migrations                migrações de dados já feitas
//
// A reserva usa uma transação sobre o documento do dia: duas pessoas não conseguem pegar o mesmo horário.
import { ADMIN_EMAIL_SHA256 } from './config.js';
import { firebaseConfig } from './firebase-config.js';
import {
  addDays, busyIntervals, computeSlots, DATE_RE, DEFAULT_AVAILABILITY, DEFAULT_PROFILE, minutes, nowLocal,
  overlaps, phoneKey, phoneMatches, STATUSES, TIME_RE, upgradeRules, validateAvailability,
} from './data/logic.js';

export const DEMO = new URLSearchParams(location.search).has('demo') || !firebaseConfig.apiKey;
export const store = DEMO
  ? (await import('./data/store-demo.js')).createDemoStore()
  : (await import('./data/store-firebase.js')).createFirebaseStore(firebaseConfig);

export const ROLE_NAMES = { admin: 'Administrador', profissional: 'Atendente', auxiliar: 'Auxiliar', cliente: 'Cliente' };
// Quem cada perfil pode cadastrar num grupo
// Níveis do auxiliar, por grupo: 'clientes' (secretaria: cadastra e vê os dados dos clientes) ou
// 'agenda' (só agenda, vê apenas o nome dos clientes). Sem o campo = 'clientes'.
export const AUX_ACCESS = { clientes: 'Secretaria (gerencia clientes)', agenda: 'Só agenda (vê só o nome dos clientes)' };
export const CAN_ADD = {
  admin: ['profissional', 'auxiliar', 'cliente'],
  profissional: ['auxiliar', 'cliente'],
  auxiliar: ['cliente'],
  agenda: [],
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
async function sha256Hex(textValue) {
  if (!crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(textValue));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Hash do e-mail guardado no agendamento: o cliente com esse e-mail (confirmado) vê o agendamento. */
const emailHash = (email) => (email ? sha256Hex(String(email).toLowerCase()) : Promise.resolve(''));
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
/** Papel efetivo para cadastrar no grupo: auxiliar "só agenda" não cadastra ninguém. */
const addKeyIn = (gid) => {
  const g = isAdmin() ? null : session?.groups.find((x) => x.gid === gid);
  if (g?.role === 'auxiliar' && g.access === 'agenda') return 'agenda';
  return roleIn(gid) || 'cliente';
};
const canAddIn = (gid) => CAN_ADD[addKeyIn(gid)] || [];
/** Pode ver telefone/e-mail dos clientes deste atendente? (auxiliar "só agenda" não) */
export const canSeeContacts = (pid) => Boolean(session?.manages.find((p) => p.id === pid)?.contacts);
/** Pode ver os contatos das pessoas deste grupo? */
const contactsIn = (gid) => isAdmin() || ['profissional'].includes(roleIn(gid))
  || (roleIn(gid) === 'auxiliar' && addKeyIn(gid) !== 'agenda');

/** Contatos das pessoas de um grupo: Map uid → {email, phone} (vazio sem permissão; null se a leitura falhar). */
async function groupContacts(gid) {
  if (!contactsIn(gid)) return new Map();
  try {
    const rows = await store.list('contacts', [['gid', '==', gid]]);
    return new Map(rows.map((c) => [c.uid, { email: c.email || '', phone: c.phone || '' }]));
  } catch (err) {
    // ex.: regras do Firestore ainda sem a coleção contacts — o grupo abre sem os contatos
    console.warn('contatos', err);
    return null;
  }
}
const withContact = (m, map) => ({ ...m, email: map.get(m.uid)?.email ?? m.email ?? '', phone: map.get(m.uid)?.phone ?? m.phone ?? '' });
const contactDoc = (gid, uid, email, phone) => [`contacts/${gid}_${uid}`, { gid, uid, email: email || '', phone: phone || '' }];
const safeGet = (path) => store.get(path).catch(() => null);

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
        gid: group.gid, uid, role: 'cliente', name, group_name: group.name, added_by: uid, added_at: nowIso(),
      });
      t.set(...contactDoc(group.gid, uid, email, phone));
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
        gid: group.gid, uid: g.uid, role: 'cliente', name, group_name: group.name, added_by: g.uid, added_at: nowIso(),
      });
      t.set(...contactDoc(group.gid, g.uid, email, ''));
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
    groups: memberships.map((m) => ({ gid: m.gid, name: m.group_name, role: m.role, access: m.access || 'clientes' })).sort(byName),
    manages: [],
    profile: null,
    // O admin só vale com o e-mail confirmado (as regras do Firestore exigem isso)
    needsVerification: user.role === 'admin' && !store.emailVerified(),
  };
  if (user.role === 'profissional') {
    const p = await getProf(uid);
    result.profile = profileOut(p);
    result.manages = [{ id: uid, name: p.name, title: p.title, contacts: true }];
  } else if (user.role === 'auxiliar') {
    const links = (await store.list('staff', [['aux', '==', uid]])).filter((s) => s.gids?.length);
    const profs = await Promise.all(links.map((s) => store.get(`professionals/${s.pid}`)));
    // Vê os contatos dos clientes se for "secretaria" em algum grupo em comum com o atendente
    const fullIn = new Set(result.groups.filter((g) => g.access !== 'agenda').map((g) => g.gid));
    result.manages = profs.map((p, i) => p && ({
      id: p.id, name: p.name, title: p.title, contacts: links[i].gids.some((g) => fullIn.has(g)),
    })).filter(Boolean).sort(byName);
  } else if (user.role === 'admin' && !result.needsVerification) {
    const profs = await store.list('professionals');
    result.manages = profs.map((p) => ({ id: p.id, name: p.name, title: p.title, contacts: true })).sort(byName);
  }
  session = result;
  if (user.role === 'admin' && !result.needsVerification) await migrateContacts().catch((err) => console.warn('migração', err));
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
    for (const g of session.groups) {
      t.update(`memberships/${g.gid}_${uid}`, { name });
      t.set(...contactDoc(g.gid, uid, email, phone));
    }
  });
}

// ---------------------------------------------------------------- migração

/**
 * Uma vez, pelo admin: tira telefone/e-mail de memberships e appointments (contatos ficam em contacts/ e
 * apptContacts/), põe o hash do e-mail nos agendamentos e cria os vínculos fullstaff das secretarias.
 */
async function migrateContacts() {
  const meta = await store.get('meta/migrations');
  if (meta?.contacts_v1) return;
  const [members, appts, staff] = await Promise.all([store.list('memberships'), store.list('appointments'), store.list('staff')]);
  for (const m of members) {
    if (m.email === undefined && m.phone === undefined) continue;
    await store.set(...contactDoc(m.gid, m.uid, m.email, m.phone));
    await store.removeFields(`memberships/${m.id}`, ['email', 'phone']);
  }
  for (const a of appts) {
    if (a.client_phone === undefined && a.client_email === undefined) continue;
    if (a.client_phone || a.client_email) {
      await store.set(`apptContacts/${a.id}`, { professional_id: a.professional_id, client_phone: a.client_phone || '', client_email: a.client_email || '' });
    }
    await store.update(`appointments/${a.id}`, { client_email_hash: await emailHash(a.client_email), client_ref: a.client_ref || '' });
    await store.removeFields(`appointments/${a.id}`, ['client_phone', 'client_email']);
  }
  const byKey = new Map(members.map((m) => [m.id, m]));
  for (const st of staff) {
    for (const g of st.gids || []) {
      if (byKey.get(`${g}_${st.aux}`)?.access !== 'agenda') await linkStaff(st.pid, st.aux, g, true, 'fullstaff');
    }
  }
  await store.set('meta/migrations', { contacts_v1: nowIso() }, true);
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
  const [group, members, map] = await Promise.all([
    store.get(`groups/${gid}`), store.list('memberships', [['gid', '==', gid]]), groupContacts(gid)]);
  if (!group) fail('Grupo não encontrado.', 404);
  const contactsError = map === null;
  const contacts = contactsIn(gid) && !contactsError;
  const list = members.sort(byName).map((m) => (contacts ? withContact(m, map) : { ...m, email: '', phone: '' }));
  return {
    gid, name: group.name, myRole: r, canAdd: canAddIn(gid), contacts, contactsError, members: list,
    canSetAccess: ['admin', 'profissional'].includes(r),
  };
}

/**
 * Pessoas que já têm conta e podem ser adicionadas ao grupo: todas as contas para o admin; para atendente e
 * auxiliar, as pessoas dos outros grupos que eles gerenciam. Só perfis que o usuário pode cadastrar.
 */
export async function knownPeople(gid) {
  const allowed = canAddIn(gid);
  if (!allowed.length) return [];
  const inGroup = new Set((await store.list('memberships', [['gid', '==', gid]])).map((m) => m.uid));
  let people;
  const fromMember = (m) => ({ uid: m.uid, name: m.name, email: m.email || '', phone: m.phone || '', role: m.role, no_account: Boolean(m.no_account) });
  if (isAdmin()) {
    const [users, noAccount, contacts] = await Promise.all([
      store.list('users'), store.list('memberships', [['no_account', '==', true]]), store.list('contacts')]);
    const map = new Map(contacts.map((c) => [c.uid, c]));
    people = users.map((u) => ({ uid: u.id, name: u.name, email: u.email, phone: u.phone || '', role: u.role, no_account: false }))
      .concat(noAccount.map((m) => fromMember(withContact(m, map))));
  } else {
    const others = session.groups.filter((g) => g.gid !== gid && ['profissional', 'auxiliar'].includes(g.role));
    const lists = await Promise.all(others.map(async (g) => {
      const [ms, map] = await Promise.all([store.list('memberships', [['gid', '==', g.gid]]), groupContacts(g.gid)]);
      return ms.map((m) => withContact(m, map || new Map()));
    }));
    people = lists.flat().map(fromMember);
  }
  const seen = new Set();
  return people
    .filter((p) => allowed.includes(p.role) && !inGroup.has(p.uid) && !seen.has(p.uid) && seen.add(p.uid))
    .sort(byName);
}

/**
 * Atualiza o vínculo auxiliar ↔ atendente de um grupo (acrescenta ou retira o grupo da lista).
 * kind 'staff' dá acesso à agenda; 'fullstaff' (só secretaria) dá acesso aos contatos dos clientes.
 */
async function linkStaff(pid, aux, gid, add, kind = 'staff') {
  await store.tx(async (t) => {
    const path = `${kind}/${pid}_${aux}`;
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
export async function addMember(gid, { name, email, phone, role: newRole, no_account: noAccount, cid, access }) {
  const uid0 = requireUid();
  if (!canAddIn(gid).includes(newRole)) fail('Você não pode cadastrar este perfil neste grupo.', 403);
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
    const [rawMembers, map] = await Promise.all([store.list('memberships', [['gid', '==', gid]]), groupContacts(gid)]);
    const members = rawMembers.map((m) => withContact(m, map));
    const dup = members.find((m) => (email && m.email === email) || (phone && phoneKey(m.phone) === phoneKey(phone)));
    if (dup) fail(`${dup.name} já está no grupo com este ${email ? 'e-mail' : 'telefone'}.`);
    const contactId = cid || `c_${store.newId('memberships')}`;
    await store.tx(async (t) => {
      t.set(`memberships/${gid}_${contactId}`, {
        gid, uid: contactId, role: 'cliente', no_account: true, name, group_name: group.name, added_by: uid0, added_at: nowIso(),
      });
      t.set(...contactDoc(gid, contactId, email, phone));
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

  const [rawMembers, map] = await Promise.all([store.list('memberships', [['gid', '==', gid]]), groupContacts(gid)]);
  const members = rawMembers.map((m) => withContact(m, map));
  const auxAccess = access === 'agenda' ? 'agenda' : 'clientes';
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
      gid, uid, role: newRole, name, group_name: group.name, added_by: uid0, added_at: nowIso(),
      ...(newRole === 'auxiliar' ? { access: auxAccess } : {}),
    });
    t.set(...contactDoc(gid, uid, email, phone));
  });
  // Auxiliar passa a gerenciar os atendentes do grupo (e vice-versa); secretaria também vê os contatos
  if (newRole === 'auxiliar') {
    for (const m of members.filter((x) => x.role === 'profissional')) {
      await linkStaff(m.uid, uid, gid, true);
      if (auxAccess === 'clientes') await linkStaff(m.uid, uid, gid, true, 'fullstaff');
    }
  } else if (newRole === 'profissional') {
    for (const m of members.filter((x) => x.role === 'auxiliar')) {
      await linkStaff(uid, m.uid, gid, true);
      if (m.access !== 'agenda') await linkStaff(uid, m.uid, gid, true, 'fullstaff');
    }
  }
  if (newRole === 'cliente') {
    const contacts = members.filter((m) => m.no_account && m.email === email);
    for (const c of contacts) {
      await store.remove(`contacts/${gid}_${c.uid}`);
      await store.remove(`memberships/${gid}_${c.uid}`);
    }
  }
  if (created && !store.demo) await store.resetPassword(email);
  return { created };
}

/** Muda o nível de um auxiliar no grupo (atendente ou admin). */
export async function setAuxAccess(gid, uid, access) {
  requireUid();
  if (!['admin', 'profissional'].includes(roleIn(gid))) fail('Apenas o atendente ou o administrador muda isto.', 403);
  if (!(access in AUX_ACCESS)) fail('Nível inválido.');
  await store.update(`memberships/${gid}_${uid}`, { access });
  const profs = (await store.list('memberships', [['gid', '==', gid]])).filter((m) => m.role === 'profissional');
  for (const p of profs) await linkStaff(p.uid, uid, gid, access === 'clientes', 'fullstaff');
}

export async function removeMember(gid, uid) {
  requireUid();
  const m = await store.get(`memberships/${gid}_${uid}`);
  if (!m) fail('Esta pessoa não está no grupo.', 404);
  if (!canAddIn(gid).includes(m.role)) fail('Você não pode retirar esta pessoa do grupo.', 403);
  const members = await store.list('memberships', [['gid', '==', gid]]);
  if (m.role === 'auxiliar') {
    for (const p of members.filter((x) => x.role === 'profissional')) {
      await linkStaff(p.uid, uid, gid, false);
      await linkStaff(p.uid, uid, gid, false, 'fullstaff');
    }
  } else if (m.role === 'profissional') {
    for (const a of members.filter((x) => x.role === 'auxiliar')) {
      await linkStaff(uid, a.uid, gid, false);
      await linkStaff(uid, a.uid, gid, false, 'fullstaff');
    }
  }
  await store.remove(`contacts/${gid}_${uid}`);
  await store.remove(`memberships/${gid}_${uid}`);
}

/** Cliente já logado que abriu o link de convite de outro grupo. */
export async function joinGroup(gid) {
  const uid = requireUid();
  if (role() !== 'cliente') fail('O convite é para clientes. Peça a quem administra o grupo para incluir você.');
  const group = await getInvite(gid);
  if (session.groups.some((g) => g.gid === gid)) return;
  const u = session.user;
  await store.tx(async (t) => {
    t.set(`memberships/${gid}_${uid}`, {
      gid, uid, role: 'cliente', name: u.name, group_name: group.name, added_by: uid, added_at: nowIso(),
    });
    t.set(...contactDoc(gid, uid, u.email, u.phone));
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

/** Horários livres (visão de quem gerencia) de cada dia entre `from` e `to`, para um serviço. */
export async function freeSlotsRange(pid, serviceId, from, to) {
  requireManager(pid);
  const days = [];
  for (let d = from; d <= to && days.length < 31; d = addDays(d, 1)) days.push(d);
  const [prof, service, blocks, dayDocs] = await Promise.all([
    getProf(pid), store.get(`professionals/${pid}/services/${serviceId}`), store.list(`professionals/${pid}/blocks`),
    Promise.all(days.map((d) => store.get(`professionals/${pid}/days/${d}`)))]);
  if (!service) fail('Serviço não encontrado.', 404);
  const out = {};
  days.forEach((day, i) => {
    out[day] = computeSlots({ prof, duration: service.duration_min, day, dayDoc: dayDocs[i], blocks, enforce: false });
  });
  return { slots: out, blocks };
}

/** Grupos do atendente em que o usuário pode cadastrar clientes (para criar o cliente na hora de agendar). */
export async function bookingGroups(pid) {
  requireManager(pid);
  if (isAdmin()) {
    const ms = await store.list('memberships', [['uid', '==', pid]]);
    return ms.filter((m) => m.role === 'profissional').map((m) => ({ gid: m.gid, name: m.group_name })).sort(byName);
  }
  const mine = session.groups.filter((g) => canAddIn(g.gid).includes('cliente'));
  const hits = await Promise.all(mine.map((g) => store.get(`memberships/${g.gid}_${pid}`)));
  return mine.filter((g, i) => hits[i]?.role === 'profissional').map((g) => ({ gid: g.gid, name: g.name }));
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
  return sortByStart(await attachContacts(pid, parts.flat().map(apptOut)));
}

/** Junta telefone/e-mail aos agendamentos, para quem pode ver os contatos (lidos de apptContacts e contacts). */
async function attachContacts(pid, appts) {
  if (!canSeeContacts(pid) || !appts.length) return appts;
  const refs = [...new Set(appts.map((a) => a.client_ref).filter(Boolean))];
  const [own, byRef] = await Promise.all([
    Promise.all(appts.map((a) => safeGet(`apptContacts/${a.id}`))),
    Promise.all(refs.map((r) => safeGet(`contacts/${r}`))),
  ]);
  const refMap = new Map(refs.map((r, i) => [r, byRef[i]]));
  return appts.map((a, i) => {
    const c = own[i] || refMap.get(a.client_ref) || {};
    return { ...a, client_phone: c.client_phone ?? c.phone ?? a.client_phone ?? '', client_email: c.client_email ?? c.email ?? a.client_email ?? '' };
  });
}

/** Pedidos aguardando confirmação, de hoje em diante. */
export async function pending(pid) {
  requireManager(pid);
  const today = nowLocal().date;
  const rows = await store.list('appointments', [['professional_id', '==', pid], ['status', '==', 'pendente']]);
  return sortByStart(await attachContacts(pid, rows.filter((a) => a.day >= today).map(apptOut)));
}

/**
 * Clientes para escolher ao agendar: os clientes dos grupos do atendente (com ou sem conta) e os já atendidos
 * sem cadastro. Busca vazia lista todos. Para o auxiliar "só agenda", só os nomes.
 */
export async function clientSuggestions(pid, q = '') {
  requireManager(pid);
  const term = fold(q.trim());
  const contacts = canSeeContacts(pid);
  const groups = await profGroupsVisible(pid);
  const [past, ...groupLists] = await Promise.all([
    contacts ? store.list(`professionals/${pid}/clients`) : Promise.resolve([]),
    ...groups.map(async (g) => {
      const [ms, map] = await Promise.all([
        store.list('memberships', [['gid', '==', g.gid], ['role', '==', 'cliente']]), contacts ? groupContacts(g.gid) : new Map()]);
      return ms.map((m) => (contacts ? withContact(m, map) : { ...m, email: '', phone: '' }));
    }),
  ]);
  const seen = new Set();
  const all = [
    ...groupLists.flat().map((m) => ({
      ref: `m:${m.gid}_${m.uid}`, uid: m.no_account ? null : m.uid, name: m.name, phone: m.phone || '', email: m.email || '', group: m.group_name,
    })),
    ...past.map((c) => ({ ref: `p:${pid}/${c.id}`, uid: null, name: c.name, phone: c.phone || '', email: c.email || '', group: '' })),
  ];
  all.forEach((c) => clientRefs.set(c.ref, c));   // contato completo fica só aqui (para agendar)
  return all
    .filter((c) => !term || fold(`${c.name} ${contacts ? c.email : ''}`).includes(term) || (contacts && phoneMatches(c.phone, term)))
    .filter((c) => { const k = c.uid || c.email || `${fold(c.name)}|${phoneKey(c.phone)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort(byName)
    .slice(0, 60)
    .map((c) => (contacts ? c : { ...c, phone: '', email: '', hidden: true }));
}
const clientRefs = new Map();

/** Grupos do atendente que o usuário enxerga (admin: todos os do atendente). */
async function profGroupsVisible(pid) {
  if (isAdmin()) {
    const ms = await store.list('memberships', [['uid', '==', pid]]);
    return ms.filter((m) => m.role === 'profissional').map((m) => ({ gid: m.gid, name: m.group_name }));
  }
  const mine = session.groups.filter((g) => g.role !== 'cliente');
  if (role() === 'profissional') return mine;
  const hits = await Promise.all(mine.map((g) => store.get(`memberships/${g.gid}_${pid}`)));
  return mine.filter((g, i) => hits[i]?.role === 'profissional');
}

export async function myAppointments() {
  const uid = requireUid();
  const lists = [store.list('appointments', [['client_id', '==', uid]])];
  // Agendamentos feitos pela secretaria com o e-mail do cliente (exige e-mail confirmado)
  if (store.emailVerified() && store.email()) {
    const h = await emailHash(store.email());
    if (h) lists.push(store.list('appointments', [['client_email_hash', '==', h]]).catch(() => []));
  }
  const byId = new Map((await Promise.all(lists)).flat().map((a) => [a.id, apptOut(a)]));
  return sortByStart([...byId.values()]).reverse();
}

const clientKey = (clientId, name, phone) => (clientId
  ? `u_${clientId}`
  : `${fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${phoneKey(phone).slice(-8)}`);

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
    const ref = data.client_ref ? clientRefs.get(data.client_ref) : null;
    if (data.client_ref && !ref) fail('Cliente não encontrado. Busque de novo na lista.');
    const name = ref ? ref.name : text(data.client_name, 120);
    if (!name) fail('Informe o nome do cliente.');
    // Cliente com conta: o agendamento fica ligado à conta (aparece em "Meus agendamentos").
    // Cliente do grupo: guarda só a referência; o contato fica em contacts/ (protegido).
    client = ref
      ? { client_id: ref.uid, client_name: ref.name, client_phone: ref.phone, client_email: ref.email,
        client_ref: ref.ref.startsWith('m:') ? ref.ref.slice(2) : '' }
      : { client_id: null, client_name: name, client_phone: text(data.client_phone, 40), client_email: text(data.client_email, 200).toLowerCase(), client_ref: '' };
    if (ref && !ref.ref.startsWith('m:')) client.client_ref = '';
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
    client = { client_id: uid, client_name: u.name, client_phone: u.phone, client_email: u.email, client_ref: `${gid}_${uid}` };
    status = prof.requires_confirmation ? 'pendente' : 'confirmado';
    if (!computeSlots({ prof, duration: service.duration_min, day, dayDoc, blocks }).includes(time)) {
      fail('Este horário não está mais disponível. Escolha outro.', 409);
    }
  }

  const id = store.newId('appointments');
  const endTime = hhmm(end);
  // Telefone/e-mail ficam fora do agendamento: em apptContacts (se digitados) ou em contacts/ (client_ref)
  const appt = {
    gid, professional_id: pid, professional_name: prof.name, professional_title: prof.title || '',
    professional_location: prof.location || '',
    service_id: data.service_id, service_name: service.name, duration_min: service.duration_min,
    client_id: client.client_id, client_name: client.client_name, client_ref: client.client_ref,
    client_email_hash: await emailHash(client.client_email),
    day, start: time, end: endTime, status, notes: text(data.notes, 1000),
    created_by: uid, created_at: nowIso(), updated_at: nowIso(),
  };
  const ownContact = !client.client_ref && (client.client_phone || client.client_email);
  const dayPath = `professionals/${pid}/days/${day}`;
  await store.tx(async (t) => {
    const fresh = await t.get(dayPath);
    if (overlaps(start, end, busyIntervals(fresh, blocks, day))) {
      fail('Este horário acabou de ser ocupado. Escolha outro.', 409);
    }
    t.set(`appointments/${id}`, appt);
    if (ownContact) t.set(`apptContacts/${id}`, { professional_id: pid, client_phone: client.client_phone, client_email: client.client_email });
    t.set(dayPath, { busy: [...(fresh?.busy || []), { id, s: time, e: endTime, c: client.client_id }] });
  });
  // Sugestão de cliente sem conta para as próximas vezes (não essencial)
  if (manager && canSeeContacts(pid) && !client.client_email && !data.client_ref) {
    store.set(`professionals/${pid}/clients/${clientKey(null, client.client_name, client.client_phone)}`,
      { name: client.client_name, phone: client.client_phone, email: '', last: `${day}T${time}` }).catch(() => {});
  }
  return apptOut({ id, ...appt, client_phone: client.client_phone, client_email: client.client_email });
}

/** Muda a situação, a anotação ou o horário (remarcar: só atendente/auxiliar). */
export async function updateAppointment(id, data) {
  const uid = requireUid();
  const a = await store.get(`appointments/${id}`);
  if (!a) fail('Agendamento não encontrado.', 404);
  const pid = a.professional_id;
  const manager = isManager(pid);
  const owner = a.client_id === uid
    || (a.client_email_hash && store.emailVerified() && a.client_email_hash === await emailHash(store.email()));
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
