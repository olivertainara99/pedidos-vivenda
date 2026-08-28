// Tudo que o app lançou hoje, com o desfecho de cada pedido.
// O Jean precisa disso: hoje ele manda o pedido e nunca mais sabe o que houve.
//
// Duas chamadas para o dia inteiro:
//   1. o relatório de produtos vendidos, que traz itens, CFOP e situação de cada venda
//   2. a lista de notas do mês, para transformar o código interno da nota no número dela

import { eg, egTudo, TAG_APP } from './_egestor.js';
import { exigir } from './_sessao.js';

function dataDe(offsetDias = 0) {
  const d = new Date(Date.now() + offsetDias * 24 * 3600 * 1000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Belem' });
}

function limparCliente(nome) {
  return String(nome || '').replace(/\s*\(c[óo]d\.\s*\d+\)\s*$/i, '').trim();
}

export default async function handler(req, res) {
  if (!exigir(req, res)) return;

  const dia = dataDe(0);

  try {
    // O filtro de data do GET /nfe não funciona bem com um único dia, então
    // pegamos a janela dos últimos dias e cruzamos pelo código.
    const [linhas, notas] = await Promise.all([
      eg('POST', '/relatorios/detalhesProdutosVendidos', {
        tipoData: 'dtVenda',
        de: dia,
        ate: dia,
        tags: TAG_APP,
        mostrarCFOP: true,
        mostrarAbertas: true,
        mostrarSituacao: true,
      }),
      egTudo(`/nfe?dtIni=${dataDe(-7)}&dtFim=${dataDe(1)}&fields=codigo,numero,situacao`, 4),
    ]);

    const notaPorCodigo = new Map();
    (notas || []).forEach((n) => notaPorCodigo.set(String(n.codigo), n));

    const porVenda = new Map();
    (Array.isArray(linhas) ? linhas : []).forEach((l) => {
      const chave = String(l.venda);
      if (!porVenda.has(chave)) {
        porVenda.set(chave, {
          codigo: Number(chave),
          cliente: limparCliente(l.cliente),
          itens: [],
          total: 0,
          cfop: String(l.cfop || 'x401').replace(/^x/, '5'),
          situacaoVenda: Number(l.situacao),
          codNota: l.codsNFe ? String(l.codsNFe).split(',')[0].trim() : null,
          quando: l.dtCad || l.dtVenda,
        });
      }
      const p = porVenda.get(chave);
      const qtd = Number(l.quant) || 0;
      const preco = Number(l.preco) || 0;
      p.itens.push({ desc: l.produto, qtd, preco });
      p.total += qtd * preco;
    });

    const pedidos = [...porVenda.values()]
      .sort((a, b) => b.codigo - a.codigo)
      .map((p) => {
        const nota = p.codNota ? notaPorCodigo.get(p.codNota) : null;
        let estado = 'aguardando';
        let detalhe = 'esperando a Tainara autorizar';

        if (nota) {
          const s = Number(nota.situacao);
          if (s === 50) { estado = 'emitida'; detalhe = 'NF-e ' + nota.numero; }
          else if (s === 90) { estado = 'cancelada'; detalhe = 'NF-e ' + nota.numero + ' cancelada'; }
          else { estado = 'rascunho'; detalhe = 'nota criada, ainda não transmitida'; }
        } else if (p.situacaoVenda === 50) {
          estado = 'autorizada';
          detalhe = 'autorizada, nota ainda não gerada';
        }

        return {
          codigo: p.codigo,
          cliente: p.cliente,
          itens: p.itens,
          total: p.total,
          cfop: p.cfop,
          quando: p.quando,
          estado,
          detalhe,
        };
      });

    return res.status(200).json({ dia, pedidos });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
