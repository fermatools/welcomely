// "Adicionar à agenda" (como nas passagens aéreas): link do Google Agenda, arquivo .ics para outros
// calendários (Apple, Outlook) e, no app Android, o calendário do próprio celular.
// As horas do agendamento são locais; aqui viram UTC pelo fuso do aparelho.
import { esc, icon, modal } from './ui.js';

const STATUS_TEXT = { pendente: 'aguardando confirmação', confirmado: 'confirmado' };

/** Evento a partir de um agendamento, do ponto de vista do cliente ou de quem atende. */
export function eventFor(a, forClient) {
  const who = forClient ? a.professional_name : a.client_name;
  const details = [
    `${a.service_name} com ${who}.`,
    STATUS_TEXT[a.status] ? `Situação: ${STATUS_TEXT[a.status]}.` : '',
    !forClient && a.client_phone ? `Telefone: ${a.client_phone}` : '',
    a.notes ? `Observações: ${a.notes}` : '',
    'Agendado pelo Welcomely.',
  ].filter(Boolean).join('\n');
  return {
    uid: `${a.id}@welcomely`,
    title: `${a.service_name} — ${who}`,
    start: new Date(`${a.day}T${a.start}`),
    end: new Date(`${a.day}T${a.end}`),
    location: a.professional_location || '',
    details,
  };
}

const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function googleUrl(ev) {
  const params = new URLSearchParams({
    action: 'TEMPLATE', text: ev.title, dates: `${utc(ev.start)}/${utc(ev.end)}`, details: ev.details, location: ev.location,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

export function icsText(events) {
  const now = utc(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FERMATools//Welcomely//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const ev of events) {
    lines.push('BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${now}`, `DTSTART:${utc(ev.start)}`, `DTEND:${utc(ev.end)}`,
      `SUMMARY:${icsEscape(ev.title)}`, `DESCRIPTION:${icsEscape(ev.details)}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export function downloadIcs(events, filename) {
  const url = URL.createObjectURL(new Blob([icsText(events)], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** No app Android abre o calendário do celular; no navegador, oferece Google Agenda ou arquivo .ics. */
export function addToCalendar(ev) {
  if (window.WelcomelyAndroid?.addToCalendar) {
    window.WelcomelyAndroid.addToCalendar(ev.title, ev.start.getTime(), ev.end.getTime(), ev.location, ev.details);
    return;
  }
  const m = modal({
    title: 'Adicionar à agenda',
    body: `
      <p><b>${esc(ev.title)}</b><br><span class="muted small">${esc(ev.start.toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' }))}</span></p>
      <div class="calendar-options">
        <a class="btn primary block" href="${esc(googleUrl(ev))}" target="_blank" rel="noopener">${icon('calendar')} Google Agenda</a>
        <button type="button" class="btn block" id="ics">Outro calendário (Apple, Outlook…)</button>
      </div>`,
  });
  m.el.querySelector('#ics').addEventListener('click', () => { downloadIcs([ev], 'welcomely.ics'); m.close(); });
  m.el.querySelector('a').addEventListener('click', () => setTimeout(m.close, 100));
}
