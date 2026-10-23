import * as api from './api.js';

const PID_KEY = 'welcomely.pid';
const REDIRECT_KEY = 'welcomely.redirect';

// Sessão atual: usuário, profissionais que ele gerencia e (se profissional) o perfil.
export const state = { user: null, groups: [], manages: [], profile: null, needsVerification: false };

export async function loadMe() {
  const data = await api.me();
  Object.assign(state, data);
  return state;
}

export async function clearSession() {
  Object.assign(state, { user: null, groups: [], manages: [], profile: null, needsVerification: false });
  await api.logout().catch(() => {});
}

export function homeFor(user) {
  if (!user) return '#/entrar';
  return { cliente: '#/buscar', admin: '#/grupos' }[user.role] || '#/agenda';
}

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

// Profissional cuja agenda está sendo gerenciada (o auxiliar pode atender vários).
export function currentPid() {
  const ids = state.manages.map((p) => p.id);
  let saved = null;
  try { saved = localStorage.getItem(PID_KEY); } catch { /* ignora */ }
  return ids.includes(saved) ? saved : ids[0] ?? null;
}

export function setPid(id) {
  try { localStorage.setItem(PID_KEY, id); } catch { /* ignora */ }
}

export function canManage(pid) {
  return state.manages.some((p) => p.id === pid);
}

export function saveRedirect(hash) {
  try { sessionStorage.setItem(REDIRECT_KEY, hash); } catch { /* ignora */ }
}

export function takeRedirect() {
  try {
    const hash = sessionStorage.getItem(REDIRECT_KEY);
    sessionStorage.removeItem(REDIRECT_KEY);
    return hash;
  } catch { return null; }
}
