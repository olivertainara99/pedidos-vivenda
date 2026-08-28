import { criarCookie, cookieVazio, lerSessao, senhaConfere } from './_sessao.js';

export default async function handler(req, res) {
  // GET serve para a página saber se já existe sessão
  if (req.method === 'GET') {
    const s = lerSessao(req);
    return res.status(200).json({ papel: s ? s.papel : null });
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', cookieVazio());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não suportado.' });
  }

  const senha = (req.body && req.body.senha) || '';
  const pedido = (req.body && req.body.papel) || '';

  // A pessoa diz quem é, e a senha tem que ser a daquele papel.
  const senhaDoPapel = { dona: process.env.SENHA_TAINARA, jean: process.env.SENHA_JEAN };

  let papel = null;
  if (Object.prototype.hasOwnProperty.call(senhaDoPapel, pedido)) {
    if (senhaConfere(senha, senhaDoPapel[pedido])) papel = pedido;
  } else {
    // sem papel informado, cai no comportamento antigo: descobre pela senha
    if (senhaConfere(senha, senhaDoPapel.dona)) papel = 'dona';
    else if (senhaConfere(senha, senhaDoPapel.jean)) papel = 'jean';
  }

  if (!papel) {
    // atraso pequeno para não virar oráculo de senha
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ erro: 'Senha não confere.' });
  }

  try {
    res.setHeader('Set-Cookie', criarCookie(papel));
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
  return res.status(200).json({ papel });
}
