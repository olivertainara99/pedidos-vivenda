// Clientes e produtos, direto do cadastro do eGestor.
// Só a linha de suco de cana entra — igual ao combinado no app.

import { egTudo } from './_egestor.js';
import { exigir } from './_sessao.js';

let cache = { em: 0, dados: null };
const VALIDADE = 10 * 60 * 1000;

export default async function handler(req, res) {
  if (!exigir(req, res)) return;

  if (cache.dados && Date.now() - cache.em < VALIDADE) {
    return res.status(200).json(cache.dados);
  }

  try {
    const [contatos, produtos] = await Promise.all([
      egTudo('/contatos?fields=codigo,nome,fantasia,cidade,bairro,cpfcnpj&orderBy=nome,asc'),
      egTudo('/produtos?fields=codigo,descricao,precoVenda,unidadeTributada&orderBy=descricao,asc'),
    ]);

    const sucos = produtos
      .filter((p) => /^SUCO DE CANA/.test(p.descricao || ''))
      .map((p) => ({
        codigo: p.codigo,
        descricao: p.descricao,
        preco: Number(p.precoVenda) || 0,
        unidade: p.unidadeTributada || 'UN',
      }));

    const dados = {
      clientes: contatos.map((c) => ({
        codigo: c.codigo,
        nome: c.nome,
        fantasia: c.fantasia || '',
        local: [c.bairro, c.cidade].filter(Boolean).map((s) => String(s).trim()).join(' · '),
        cpfcnpj: c.cpfcnpj || '',
      })),
      produtos: sucos,
      atualizadoEm: new Date().toISOString(),
    };

    cache = { em: Date.now(), dados };
    return res.status(200).json(dados);
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
