// Avisar o cliente sobre confirmação, remarcação ou cancelamento.
// Sem servidor de envio: abre o e-mail (ou o WhatsApp) de quem está usando o app, com a mensagem pronta;
// a pessoa só confere e toca em Enviar.
import { eventFor, googleUrl } from './calendar.js';
import { whatsappDigits } from './data/logic.js';
import { esc, fmtDay, icon, modal } from './ui.js';

const HEADLINE = {
  confirmado: 'está confirmado',
  remarcado: 'foi remarcado',
  cancelado: 'foi cancelado',
};

export function messageFor(a, kind) {
  const when = `${fmtDay(a.day)}, às ${a.start}`;
  const lines = [
    `Olá, ${a.client_name.split(' ')[0]}!`,
    '',
    `Seu agendamento de ${a.service_name} com ${a.professional_name} ${HEADLINE[kind]}.`,
    '',
    `${kind === 'cancelado' ? 'Era em' : 'Quando'}: ${when}`,
  ];
  if (kind !== 'cancelado' && a.professional_location) lines.push(`Onde: ${a.professional_location}`);
  if (kind !== 'cancelado') lines.push('', `Adicionar ao Google Agenda: ${googleUrl(eventFor(a, true))}`);
  else lines.push('', 'Se quiser, marque um novo horário pelo Welcomely.');
  lines.push('', `${a.professional_name}`, 'Enviado pelo Welcomely');
  return {
    subject: `Agendamento ${HEADLINE[kind].replace(/^(está|foi) /, '')}: ${a.service_name}, ${when.charAt(0).toLowerCase()}${when.slice(1)}`,
    body: lines.join('\n'),
  };
}

export function mailtoUrl(a, kind) {
  const { subject, body } = messageFor(a, kind);
  return `mailto:${encodeURIComponent(a.client_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}`;
}

export function whatsappUrl(a, kind) {
  const n = whatsappDigits(a.client_phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(messageFor(a, kind).body)}` : '';
}

/** Janela "Avisar o cliente?" com e-mail e WhatsApp (quando houver contato). */
export function notifyClient(a, kind = 'confirmado') {
  const mail = a.client_email ? mailtoUrl(a, kind) : '';
  const wa = whatsappUrl(a, kind);
  const titles = { confirmado: 'Agendamento confirmado', remarcado: 'Agendamento remarcado', cancelado: 'Agendamento cancelado' };
  const m = modal({
    title: titles[kind],
    body: `
      <p>Avisar <b>${esc(a.client_name)}</b>?</p>
      ${mail || wa ? `<div class="calendar-options">
        ${mail ? `<a class="btn primary block" href="${esc(mail)}" data-go>${icon('note')} Enviar e-mail</a>` : ''}
        ${wa ? `<a class="btn block" href="${esc(wa)}" target="_blank" rel="noopener" data-go>${icon('phone')} WhatsApp</a>` : ''}
        <button type="button" class="btn ghost block" data-close>Agora não</button>
      </div>
      <p class="muted small">Abre o seu e-mail ou o WhatsApp com a mensagem pronta; é só conferir e enviar.</p>`
      : `<p class="muted">Este cliente não tem e-mail nem telefone cadastrados.</p>
        <div class="calendar-options"><button type="button" class="btn block" data-close>Fechar</button></div>`}`,
  });
  m.el.querySelectorAll('[data-go]').forEach((link) => link.addEventListener('click', () => setTimeout(m.close, 300)));
}
