// Histórico dos pedidos lançados pelo app, agrupado por dia.
// O Jean precisa disso: sem ele, o pedido some da vista assim que é enviado.
//
// Duas chamadas cobrem a janela inteira, independente de quantos pedidos tenha:
//   1. o relatório de produtos vendidos — itens, CFOP e situação de cada venda
//   2. a lista de notas do período — para virar o código interno no número da NF-e

import { eg, egTudo, TAG_APP } from './_egestor.js';
import { exigir } from './_sessao.js';

const DIAS_PADRAO = 30;
const DIAS_MAX = 365;

function data(offsetDias = 0) {
  const d = new Date(Date.now() + offsetDias * 24 * 3600 * 1000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Belem' });
}

function limparCliente(nome) {
  return String(nome || '').replace(/\s*\(c[óo]d\.\s*\d+\)\s*$/i, '').trim();
}

export default async function handler(req, res) {
  if (!exigir(req, res)) return;

  const pedidoDias = Number(req.query.dias);
  const dias = Math.min(Math.max(Number.isFinite(pedidoDias) ? pedidoDias : DIAS_PADRAO, 1), DIAS_MAX);
  const de = data(-(dias - 1));
  const ate = data(0);

  try {
    const [linhas, notas] = await Promise.all([
      eg('POST', '/relatorios/detalhesProdutosVendidos', {
        tipoData: 'dtVenda',
        de,
        ate,
        tags: TAG_APP,
        mostrarCFOP: true,
        mostrarAbertas: true,
        mostrarSituacao: true,
      }),
      egTudo(`/nfe?dtIni=${de}&dtFim=${data(1)}&fields=codigo,numero,situacao`, 8),
    ]);

    const notaPorCodigo = new Map();
    (notas || []).forEach((n) => notaPorCodigo.set(String(n.codigo), n));

    // uma venda tem várias linhas no relatório, uma por produto
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
          dia: String(l.dtVenda || '').slice(0, 10),
          quando: l.dtCad || l.dtVenda,
        });
      }
      const p = porVenda.get(chave);
      const qtd = Number(l.quant) || 0;
      const preco = Number(l.preco) || 0;
      p.itens.push({ desc: l.produto, qtd, preco });
      p.total += qtd * preco;
    });

    const pedidos = [...porVenda.values()].map((p) => {
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
        codigo: p.codigo, cliente: p.cliente, itens: p.itens, total: p.total,
        cfop: p.cfop, dia: p.dia, quando: p.quando, estado, detalhe,
      };
    });

    // agrupa por dia, do mais recente para o mais antigo
    const porDia = new Map();
    pedidos.forEach((p) => {
      if (!porDia.has(p.dia)) porDia.set(p.dia, []);
      porDia.get(p.dia).push(p);
    });

    const grupos = [...porDia.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([dia, lista]) => ({
        dia,
        pedidos: lista.sort((a, b) => b.codigo - a.codigo),
        total: lista.reduce((s, p) => s + p.total, 0),
        emitidas: lista.filter((p) => p.estado === 'emitida').length,
      }));

    return res.status(200).json({
      de,
      ate,
      dias,
      grupos,
      totalPedidos: pedidos.length,
    });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
