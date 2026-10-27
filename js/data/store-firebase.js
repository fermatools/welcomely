// Armazenamento real: Firebase Auth (e-mail/senha) + Firestore.
// Mesma interface de store-demo.js; a lógica do app fica em data/api.js.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  createUserWithEmailAndPassword, EmailAuthProvider, getAdditionalUserInfo, getAuth, GoogleAuthProvider,
  onAuthStateChanged, reauthenticateWithCredential, sendEmailVerification, sendPasswordResetEmail,
  signInWithEmailAndPassword, signInWithPopup, signOut, updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  collection, deleteDoc, deleteField, doc, getDoc, getDocs, getFirestore, limit, query, runTransaction, setDoc, updateDoc, where,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const AUTH_ERRORS = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'E-mail inválido.',
  'auth/email-already-in-use': 'Já existe uma conta com este e-mail.',
  'auth/weak-password': 'A senha deve ter pelo menos 6 caracteres.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
  'auth/network-request-failed': 'Sem conexão. Verifique sua internet.',
  'auth/popup-blocked': 'O navegador bloqueou a janela do Google. Permita pop-ups para este site e tente de novo.',
  'auth/popup-closed-by-user': 'A janela do Google foi fechada antes de terminar.',
  'auth/cancelled-popup-request': 'A janela do Google foi fechada antes de terminar.',
  'auth/unauthorized-domain': 'Este endereço ainda não está autorizado no Firebase (Authentication → Configurações → Domínios autorizados).',
  'auth/operation-not-allowed': 'O login com Google ainda não foi ativado no Firebase.',
  'auth/account-exists-with-different-credential': 'Esta conta usa e-mail e senha. Entre com a senha (ou use "Esqueci minha senha").',
  'permission-denied': 'Sem permissão para esta operação.',
  unavailable: 'Sem conexão com o servidor. Verifique sua internet.',
};

function friendly(err) {
  const msg = AUTH_ERRORS[err?.code];
  if (!msg) return err;
  const e = new Error(msg);
  e.code = err.code;
  return e;
}

const wrap = (fn) => async (...args) => {
  try { return await fn(...args); } catch (err) { throw friendly(err); }
};

export function createFirebaseStore(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  let secondaryAuth = null;
  const ref = (path) => doc(db, path);
  const snapData = (s) => (s.exists() ? { id: s.id, ...s.data() } : null);

  let resolveReady;
  const readyPromise = new Promise((r) => { resolveReady = r; });
  const listeners = new Set();
  onAuthStateChanged(auth, (user) => {
    resolveReady();
    listeners.forEach((fn) => fn(user?.uid ?? null));
  });

  function makeQuery(colPath, filters = [], max = null) {
    const parts = filters.map(([f, op, v]) => where(f, op, v));
    if (max) parts.push(limit(max));
    return query(collection(db, colPath), ...parts);
  }

  return {
    demo: false,
    ready: () => readyPromise,
    onAuthChange: (fn) => listeners.add(fn),
    uid: () => auth.currentUser?.uid ?? null,
    email: () => auth.currentUser?.email ?? null,
    emailVerified: () => Boolean(auth.currentUser?.emailVerified),

    signUp: wrap(async (email, password) => {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      sendEmailVerification(cred.user).catch(() => {});
      return cred.user.uid;
    }),
    signIn: wrap(async (email, password) => { await signInWithEmailAndPassword(auth, email, password); }),
    // Janela do Google (popup). Devolve os dados da conta e se ela acabou de ser criada no Firebase.
    signInWithGoogle: wrap(async () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await signInWithPopup(auth, provider);
      return {
        uid: cred.user.uid, email: cred.user.email, name: cred.user.displayName || '',
        isNew: Boolean(getAdditionalUserInfo(cred)?.isNewUser),
      };
    }),
    // Desfaz uma conta recém-criada pelo Google que não tem acesso ao app.
    deleteCurrentUser: wrap(async () => { await auth.currentUser?.delete(); }),
    signOut: wrap(() => signOut(auth)),
    // Cria a conta de outra pessoa (senha aleatória) numa instância secundária, sem deslogar quem cadastra.
    // A pessoa define a própria senha pelo e-mail de redefinição.
    createAccount: wrap(async (email) => {
      if (!secondaryAuth) secondaryAuth = getAuth(initializeApp(config, 'secundario'));
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const password = btoa(String.fromCharCode(...bytes));
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      await signOut(secondaryAuth);
      return cred.user.uid;
    }),
    sendVerification: wrap(() => sendEmailVerification(auth.currentUser)),
    // Relê a conta (ex.: depois de confirmar o e-mail) e renova o token usado pelas regras.
    refreshUser: wrap(async () => {
      if (!auth.currentUser) return;
      await auth.currentUser.reload();
      await auth.currentUser.getIdToken(true);
    }),
    resetPassword: wrap((email) => sendPasswordResetEmail(auth, email)),
    changePassword: wrap(async (current, next) => {
      const user = auth.currentUser;
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
      await updatePassword(user, next);
    }),

    newId: (colPath) => doc(collection(db, colPath)).id,
    get: wrap(async (path) => snapData(await getDoc(ref(path)))),
    list: wrap(async (colPath, filters, max) => (await getDocs(makeQuery(colPath, filters, max))).docs.map(snapData)),
    set: wrap((path, data, merge = false) => setDoc(ref(path), data, { merge })),
    update: wrap((path, data) => updateDoc(ref(path), data)),
    remove: wrap((path) => deleteDoc(ref(path))),
    removeFields: wrap((path, keys) => updateDoc(ref(path), Object.fromEntries(keys.map((k) => [k, deleteField()])))),
    // Transação: leituras primeiro (t.get), depois escritas (t.set/t.update/t.remove).
    tx: wrap((fn) => runTransaction(db, async (t) => fn({
      get: async (path) => snapData(await t.get(ref(path))),
      set: (path, data, merge = false) => { t.set(ref(path), data, { merge }); },
      update: (path, data) => { t.update(ref(path), data); },
      remove: (path) => { t.delete(ref(path)); },
    }))),
  };
}
