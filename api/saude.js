// Diagnóstico. Sem sessão, responde apenas quais variáveis de ambiente EXISTEM
// (nunca o conteúdo delas). Com sessão, também testa a conexão com o eGestor.

import { eg } from './_egestor.js';
import { lerSessao } from './_sessao.js';

export default async function handler(req, res) {
  const configurado = {
    EGESTOR_PERSONAL_TOKEN: !!process.env.EGESTOR_PERSONAL_TOKEN,
    SENHA_JEAN: !!process.env.SENHA_JEAN,
    SENHA_TAINARA: !!process.env.SENHA_TAINARA,
    SESSION_SECRET: !!process.env.SESSION_SECRET,
  };
  const faltando = Object.keys(configurado).filter((k) => !configurado[k]);

  const corpo = {
    ok: faltando.length === 0,
    configurado,
    faltando,
    node: process.version,
  };

  // o teste contra o eGestor gasta chamada de API: só para quem está logado
  const sessao = lerSessao(req);
  if (sessao) {
    try {
      const empresa = await eg('GET', '/empresa');
      corpo.egestor = { ok: true, empresa: empresa && (empresa.fantasia || empresa.nome) };
    } catch (e) {
      corpo.egestor = { ok: false, erro: e.message };
    }
  }

  return res.status(corpo.ok ? 200 : 503).json(corpo);
}
