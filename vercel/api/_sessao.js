// Sessão em cookie assinado. Não guarda nada no servidor: o cookie carrega o
// papel e a validade, e a assinatura HMAC impede que alguém edite o próprio papel.

import crypto from 'node:crypto';

const HORAS = 12;
const NOME = 'vds';

function segredo() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw Object.assign(new Error('SESSION_SECRET não está configurado na Vercel.'), { status: 500 });
  return s;
}

function assinar(base) {
  return crypto.createHmac('sha256', segredo()).update(base).digest('base64url');
}

export function criarCookie(papel) {
  const base = Buffer.from(JSON.stringify({ papel, exp: Date.now() + HORAS * 3600 * 1000 })).toString('base64url');
  const valor = `${base}.${assinar(base)}`;
  return `${NOME}=${valor}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${HORAS * 3600}`;
}

export function cookieVazio() {
  return `${NOME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function lerSessao(req) {
  const bruto = (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${NOME}=`));
  if (!bruto) return null;

  const [base, assinatura] = bruto.slice(NOME.length + 1).split('.');
  if (!base || !assinatura) return null;

  let esperada;
  try { esperada = assinar(base); } catch { return null; }
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const dados = JSON.parse(Buffer.from(base, 'base64url').toString());
    if (!dados.exp || Date.now() > dados.exp) return null;
    return { papel: dados.papel };
  } catch {
    return null;
  }
}

// Devolve a sessão ou responde 401 e devolve null. `papeis` restringe quem entra.
export function exigir(req, res, papeis) {
  const s = lerSessao(req);
  if (!s) {
    res.status(401).json({ erro: 'Sua sessão expirou. Entre de novo.' });
    return null;
  }
  if (papeis && !papeis.includes(s.papel)) {
    res.status(403).json({ erro: 'Este passo é da Tainara.' });
    return null;
  }
  return s;
}

// Comparação de senha em tempo constante
export function senhaConfere(informada, correta) {
  if (!informada || !correta) return false;
  const a = Buffer.from(String(informada));
  const b = Buffer.from(String(correta));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
