// Endereço do servidor da API. Vazio = o mesmo endereço de onde o app foi aberto
// (o servidor Flask serve o app web e a API juntos).
export const API_BASE = (window.WELCOMELY_API_BASE || '').replace(/\/$/, '');

export const APP_VERSION = '1.0';
export const DEVELOPER = {
  name: 'FERMATools',
  email: 'fermatools@gmail.com',
  site: 'https://fermatools.github.io/',
};
