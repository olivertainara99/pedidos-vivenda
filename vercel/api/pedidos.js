// Os pedidos vivem no próprio eGestor, como Orçamentos marcados com a tag APP_PEDIDOS.
// GET    lista os que ainda esperam autorização
// POST   cria (Jean)
// DELETE apaga um (Tainara)

import {
  eg, egTudo, erro, montarObs, lerObs, cfopPara, podeEmitirPelaApi, cfopsAplicados,
  porNoGrupo, devolverGrupos, COD_GRUPO_DE_CFOP, GRUPO_PADRAO,
  TAG_APP, COD_VENDEDOR,
} from './_egestor.js';
import { exigir } from './_sessao.js';

const MAX_DETALHAR = 30;

function hoje() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Belem' }); // AAAA-MM-DD
}

export default async function handler(req, res) {
  const sessao = exigir(req, res);
  if (!sessao) return;

  try {
    if (req.method === 'GET') return await listar(req, res);
    if (req.method === 'POST') return await criar(req, res, sessao);
    if (req.method === 'DELETE') {
      // apagar é só da Tainara
      if (sessao.papel !== 'dona') {
        return res.status(403).json({ erro: 'Só a Tainara apaga pedido.' });
      }
      return await apagar(req, res);
    }
    return res.status(405).json({ erro: 'Método não suportado.' });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message, detalhe: e.detalhe });
  }
}

async function listar(req, res) {
  const resumo = await egTudo(`/vendas?tipo=10&filtro=${TAG_APP}&fields=codigo,nomeContato,valorTotal,dtVenda,dtCad,tags`, 3);

  const emOrdem = resumo.sort((a, b) => b.codigo - a.codigo).slice(0, MAX_DETALHAR);

  // uma chamada só cobre a fila toda
  let cfopsPorVenda = {};
  try { cfopsPorVenda = await cfopsAplicados(); } catch { /* sem isso o app avisa que não leu */ }

  const pedidos = [];
  for (const r of emOrdem) {
    const d = await eg('GET', `/vendas/${r.codigo}`);
    const obs = lerObs(d.customizado && d.customizado.xCampo1);
    pedidos.push({
      codigo: d.codigo,
      cliente: { codigo: d.codContato, nome: d.nomeContato },
      itens: (d.produtos || []).map((p) => ({
        codigo: p.codProduto,
        desc: p.descricao,
        qtd: Number(p.quant) || 0,
        preco: Number(p.preco) || 0,
      })),
      totalProdutos: (d.produtos || []).reduce((s, p) => s + (Number(p.quant) || 0) * (Number(p.preco) || 0), 0),
      cfop: obs.cfop,
      por: obs.por,
      recusado: obs.recusado,
      // o CFOP depende do grupo de tributos da linha, que só se troca pela tela;
      // avisamos aqui para ela ver antes de executar, não só na hora do erro
      emissao: podeEmitirPelaApi(obs.cfop, cfopsPorVenda[String(d.codigo)]),
      totalST: (d.produtos || []).reduce((s, p) => s + (Number(p.valorST) || 0), 0),
      dtCad: d.dtCad || d.dtVenda,
      publicURL: d.publicURL || null,
    });
  }

  return res.status(200).json({
    pedidos: pedidos.filter((p) => !p.recusado),
    recusados: pedidos.filter((p) => p.recusado),
  });
}

async function criar(req, res, sessao) {
  const c = req.body || {};
  const codContato = Number(c.codContato);
  const itens = Array.isArray(c.itens) ? c.itens : [];
  const por = String(c.por || (sessao.papel === 'dona' ? 'Tainara' : 'Jean')).slice(0, 40);

  if (!codContato) throw erro(400, 'Escolha o cliente.');
  if (!itens.length) throw erro(400, 'Ponha a quantidade de pelo menos um produto.');

  // o CFOP sai da regra, a partir do cliente e de quem está lançando
  const contato = await eg('GET', `/contatos/${codContato}`);
  if (!contato || !contato.nome) throw erro(400, 'Cliente não encontrado no cadastro.');
  const cfop = cfopPara(contato.nome, sessao.papel);

  // preços vêm do cadastro no momento do lançamento, nunca do navegador
  const catalogo = await egTudo('/produtos?fields=codigo,descricao,precoVenda');
  const porCod = new Map(catalogo.map((p) => [Number(p.codigo), p]));

  const produtos = [];
  for (const i of itens) {
    const cod = Number(i.codProduto);
    const qtd = Math.floor(Number(i.quant));
    const p = porCod.get(cod);
    if (!p) throw erro(400, `Produto ${cod} não existe no cadastro.`);
    if (!(qtd > 0)) throw erro(400, `Quantidade inválida em ${p.descricao}.`);
    produtos.push({ codProduto: cod, quant: qtd, preco: Number(p.precoVenda) || 0, vDesc: 0 });
  }

  // O CFOP vem do grupo de tributos do produto, e a venda fotografa esse grupo
  // no instante da criação. Então: põe os produtos no grupo certo, cria, devolve.
  const grupo = COD_GRUPO_DE_CFOP[cfop] || GRUPO_PADRAO;
  const codigos = produtos.map((p) => p.codProduto);

  let mexidos = [];
  let criado;
  try {
    mexidos = await porNoGrupo(codigos, grupo);
    criado = await eg('POST', '/vendas', {
      codContato,
      codVendedor: COD_VENDEDOR,
      dtVenda: hoje(),
      situacao: 10, // Orçamento: ainda não é venda
      tags: [TAG_APP],
      customizado: { xCampo1: montarObs({ por, cfop }) },
      produtos,
    });
  } finally {
    if (mexidos.length) await devolverGrupos(mexidos);
  }

  return res.status(201).json({ codigo: criado.codigo, valorTotal: criado.valorTotal, cfop });
}

async function apagar(req, res) {
  const codigo = Number(req.query.codigo);
  if (!codigo) throw erro(400, 'Informe o código do pedido.');

  const d = await eg('GET', `/vendas/${codigo}`);
  if (Number(d.situacao) !== 10) {
    throw erro(409, 'Este pedido já virou venda — não dá para apagar por aqui.');
  }
  if (!(d.tags || []).includes(TAG_APP)) {
    throw erro(409, 'Esse orçamento não foi criado por este app.');
  }

  await eg('DELETE', `/vendas/${codigo}`);
  return res.status(200).json({ ok: true });
}
