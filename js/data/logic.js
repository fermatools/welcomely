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
  for (const rule of (prof.availability || []).filter((r) => r.weekday === weekday(day))) {
    const limit = minutes(rule.end_time);
    for (let t = minutes(rule.start_time); t + duration <= limit; t += step) {
      if (t >= earliest && !overlaps(t, t + duration, busy)) slots.add(hhmm(t));
    }
  }
  return [...slots].sort();
}

/** Valida a grade semanal: horários válidos, início < fim e sem sobreposição no mesmo dia. */
export function validateAvailability(rules) {
  if (!Array.isArray(rules)) throw new Error('Lista de horários inválida.');
  const clean = rules.map((r) => {
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) throw new Error('Dia da semana inválido.');
    if (!TIME_RE.test(r.start_time) || !TIME_RE.test(r.end_time)) throw new Error('Horário inválido (use HH:MM).');
    if (minutes(r.start_time) >= minutes(r.end_time)) throw new Error('O início deve ser antes do fim em cada intervalo.');
    return { weekday: r.weekday, start_time: r.start_time, end_time: r.end_time };
  });
  for (let wd = 0; wd < 7; wd++) {
    const day = clean.filter((r) => r.weekday === wd).sort((a, b) => a.start_time.localeCompare(b.start_time));
    for (let i = 1; i < day.length; i++) {
      if (minutes(day[i].start_time) < minutes(day[i - 1].end_time)) throw new Error('Há intervalos sobrepostos no mesmo dia.');
    }
  }
  return clean.sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
}

export const DEFAULT_AVAILABILITY = [0, 1, 2, 3, 4].flatMap((weekday) => [
  { weekday, start_time: '09:00', end_time: '12:00' },
  { weekday, start_time: '14:00', end_time: '18:00' },
]);

export const DEFAULT_PROFILE = {
  title: '', bio: '', location: '',
  requires_confirmation: true, min_notice_hours: 2, max_days_ahead: 60, cancel_notice_hours: 12,
  slot_interval_min: 30, public: true,
};
