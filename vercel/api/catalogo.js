// Clientes e produtos, direto do cadastro do eGestor.
// Só entram no app os itens que o Jean e a Tainara lançam: a linha de suco de
// cana, o mel e o biscoito. Caldo de cana, equipamentos e o resto do cadastro
// ficam de fora — se precisarem de nota, sai pela tela do eGestor.
const NO_APP = /^SUCO DE CANA|^MEL DE CANA|^BISCOITO COM MEL DE CANA/;

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
      .filter((p) => NO_APP.test(p.descricao || ''))
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
