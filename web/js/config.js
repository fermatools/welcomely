export const APP_VERSION = '1.0';
export const DEVELOPER = {
  name: 'FERMATools',
  email: 'fermatools@gmail.com',
  site: 'https://fermatools.github.io/',
};

// Conta de administrador: só o hash SHA-256 do e-mail (minúsculo), para o endereço não ficar público.
// O mesmo hash está em firestore.rules; lá o admin só vale com o e-mail confirmado.
// Para trocar: printf '%s' 'email@exemplo.com' | sha256sum
export const ADMIN_EMAIL_SHA256 = '21a1e460a64509a23d74917084fb45317f941fba35b19e8d7d4e7de5a40325d0';
