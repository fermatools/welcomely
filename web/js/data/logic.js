// Regras puras (sem acesso a dados): horários livres, sobreposição, datas.
// Datas trafegam como texto "AAAA-MM-DD" e horas como "HH:MM", na hora local.

export const ACTIVE = ['pendente', 'confirmado'];
export const STATUSES = ['pendente', 'confirmado', 'cancelado', 'concluido', 'faltou'];

const pad = (n) => String(n).padStart(2, '0');
export const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); };
// Segunda = 0 ... domingo = 6
export const weekday = (s) => (parseDate(s).getDay() + 6) % 7;

export function nowLocal() {
  const d = new Date();
  return { date: isoDate(d), min: d.getHours() * 60 + d.getMinutes() };
}

// ------------------------------------------------------------ telefones
/**
 * Chave para comparar telefones escritos de jeitos diferentes: só dígitos, sem o +55 do Brasil e sem
 * zeros à esquerda. Ex.: "(21) 99999-9999", "+55 21 99999-9999" e "021999999999" → "21999999999".
 */
export function phoneKey(phone) {
  let d = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d;
}

/** Busca por parte de um telefone, em qualquer formato ("+55 21 9999" também acha "(21) 99999-0000"). */
export function phoneMatches(phone, query) {
  const q = String(query || '').replace(/\D/g, '').replace(/^0+/, '');
  if (q.length < 3) return false;
  const key = phoneKey(phone);
  return key.includes(q) || (q.startsWith('55') && key.startsWith(q.slice(2)));
}

/** Número para o WhatsApp (wa.me): com o código do país; sem código, assume Brasil. */
export function whatsappDigits(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return '';
  if (raw.startsWith('+') && !digits.startsWith('55')) return digits;   // outro país
  return `55${phoneKey(raw)}`;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutos de [início, fim) que ficam ocupados em `day` por bloqueios (que podem durar vários dias). */
export function blockIntervals(blocks, day) {
  const out = [];
  for (const b of blocks) {
    const sd = b.starts_at.slice(0, 10);
    const ed = b.ends_at.slice(0, 10);
    if (ed < day || sd > day || (ed === day && b.ends_at.slice(11) === '00:00')) continue;
    const s = sd < day ? 0 : minutes(b.starts_at.slice(11));
    const e = ed > day ? 24 * 60 : minutes(b.ends_at.slice(11));
    if (e > s) out.push([s, e]);
  }
  return out;
}

/** Intervalos ocupados do dia: agendamentos ativos (doc do dia) + bloqueios. */
export function busyIntervals(dayDoc, blocks, day, ignoreId = null) {
  const busy = (dayDoc?.busy || []).filter((b) => b.id !== ignoreId).map((b) => [minutes(b.s), minutes(b.e)]);
  return busy.concat(blockIntervals(blocks, day));
}

export const overlaps = (s, e, busy) => busy.some(([bs, be]) => s < be && e > bs);

/**
 * Horários livres "HH:MM" em `day` para um atendimento de `duration` minutos.
 * `enforce` aplica antecedência mínima e janela máxima (desligado para profissional/auxiliar).
 */
export function computeSlots({ prof, duration, day, dayDoc, blocks, enforce = true, now = nowLocal() }) {
  if (day < now.date) return [];
  if (enforce && day > addDays(now.date, prof.max_days_ahead)) return [];
  let earliest = -1;
  if (day === now.date) earliest = now.min + (enforce ? prof.min_notice_hours * 60 : 0);
  else if (enforce && prof.min_notice_hours) {
    // antecedência que atravessa a meia-noite
    const until = now.min + prof.min_notice_hours * 60;
    const daysAhead = Math.round((parseDate(day) - parseDate(now.date)) / 864e5);
    earliest = until - daysAhead * 24 * 60;
  }
  const busy = busyIntervals(dayDoc, blocks, day);
  const step = prof.slot_interval_min || duration;
  const slots = new Set();
  for (const rule of rulesForDay(prof.availability, day)) {
    const limit = minutes(rule.end_time);
    for (let t = minutes(rule.start_time); t + duration <= limit; t += step) {
      if (t >= earliest && !overlaps(t, t + duration, busy)) slots.add(hhmm(t));
    }
  }
  return [...slots].sort();
}

// ------------------------------------------------------------ regras de horário
// Regra (como as repetições do Google Agenda):
//   { repeat: 'weekly' | 'monthly' | 'once', days: [0..6], start_time, end_time,
//     interval: 1..4 (weekly: a cada N semanas), week_of_month: 1..4 | -1 (monthly: 1ª..4ª ou última),
//     date (once), from, until (opcionais, AAAA-MM-DD) }
// Regras antigas { weekday, start_time, end_time } valem como "toda semana".
export const REPEATS = ['weekly', 'monthly', 'once'];

export function normalizeRule(r) {
  if (!r.repeat) return { repeat: 'weekly', days: [r.weekday], start_time: r.start_time, end_time: r.end_time, interval: 1, from: '', until: '' };
  return {
    repeat: r.repeat, days: r.days || [], start_time: r.start_time, end_time: r.end_time,
    interval: r.interval || 1, week_of_month: r.week_of_month ?? 1, date: r.date || '', from: r.from || '', until: r.until || '',
  };
}

const mondayOf = (s) => addDays(s, -weekday(s));

export function ruleApplies(rule, day) {
  const r = normalizeRule(rule);
  if (r.repeat === 'once') return r.date === day;
  if ((r.from && day < r.from) || (r.until && day > r.until)) return false;
  if (!r.days.includes(weekday(day))) return false;
  if (r.repeat === 'weekly') {
    if (r.interval <= 1) return true;
    const weeks = Math.round((parseDate(mondayOf(day)) - parseDate(mondayOf(r.from || day))) / (7 * 864e5));
    return weeks % r.interval === 0;
  }
  // monthly: n-ésima ocorrência do dia da semana no mês (ou a última)
  const d = parseDate(day);
  const n = Math.ceil(d.getDate() / 7);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return r.week_of_month === -1 ? d.getDate() + 7 > daysInMonth : n === r.week_of_month;
}

/**
 * Converte a grade antiga ({weekday, start_time, end_time}, um registro por dia) em regras semanais,
 * juntando os dias que têm o mesmo horário. Regras no formato novo passam sem mudança.
 */
export function upgradeRules(rules) {
  const out = [];
  const merged = new Map();
  for (const r of rules || []) {
    if (r.repeat) { out.push(r); continue; }
    const key = `${r.start_time}|${r.end_time}`;
    if (!merged.has(key)) {
      merged.set(key, { repeat: 'weekly', days: [], start_time: r.start_time, end_time: r.end_time, interval: 1, from: '', until: '' });
      out.push(merged.get(key));
    }
    merged.get(key).days.push(r.weekday);
  }
  merged.forEach((r) => r.days.sort());
  return out;
}

export const rulesForDay = (rules, day) => (rules || []).map(normalizeRule).filter((r) => ruleApplies(r, day));

/** Valida e limpa a lista de regras de horário. Regras podem se sobrepor (vale a união). */
export function validateAvailability(rules) {
  if (!Array.isArray(rules)) throw new Error('Lista de horários inválida.');
  return rules.map((raw) => {
    const r = normalizeRule(raw);
    if (!REPEATS.includes(r.repeat)) throw new Error('Repetição inválida.');
    if (!TIME_RE.test(r.start_time) || !TIME_RE.test(r.end_time)) throw new Error('Horário inválido (use HH:MM).');
    if (minutes(r.start_time) >= minutes(r.end_time)) throw new Error('O início deve ser antes do fim em cada regra.');
    for (const k of ['date', 'from', 'until']) if (r[k] && !DATE_RE.test(r[k])) throw new Error('Data inválida.');
    const out = { repeat: r.repeat, start_time: r.start_time, end_time: r.end_time };
    if (r.repeat === 'once') {
      if (!r.date) throw new Error('Informe a data.');
      return { ...out, date: r.date };
    }
    const days = [...new Set(r.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) throw new Error('Escolha pelo menos um dia da semana.');
    if (r.from && r.until && r.from > r.until) throw new Error('A data final deve ser depois da inicial.');
    Object.assign(out, { days, from: r.from, until: r.until });
    if (r.repeat === 'weekly') {
      if (![1, 2, 3, 4].includes(r.interval)) throw new Error('Intervalo de semanas inválido.');
      if (r.interval > 1 && !r.from) throw new Error('Para repetir a cada algumas semanas, informe a partir de quando.');
      out.interval = r.interval;
    } else {
      if (![1, 2, 3, 4, -1].includes(r.week_of_month)) throw new Error('Semana do mês inválida.');
      out.week_of_month = r.week_of_month;
    }
    return out;
  });
}

export const DEFAULT_AVAILABILITY = [
  { repeat: 'weekly', days: [0, 1, 2, 3, 4], start_time: '09:00', end_time: '12:00', interval: 1, from: '', until: '' },
  { repeat: 'weekly', days: [0, 1, 2, 3, 4], start_time: '14:00', end_time: '18:00', interval: 1, from: '', until: '' },
];

export const DEFAULT_PROFILE = {
  title: '', bio: '', location: '',
  requires_confirmation: true, min_notice_hours: 2, max_days_ahead: 60, cancel_notice_hours: 12,
  slot_interval_min: 30, public: true,
};
