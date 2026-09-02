// Lê um PDF de pedido de compra e devolve o que entendeu — SEM criar nada.
// Quem confirma é o Jean, na tela; só depois os pedidos entram na fila.
//
// A leitura do PDF usa só o que o Node já traz (zlib). Os fluxos de texto vêm
// comprimidos com Flate; descomprimimos e pegamos as strings entre parênteses,
// que é onde o PDF guarda o texto desenhado.
//
// A identificação NÃO é por nome: o pedido chama "CALDO CANA DAMOENDA 1L" e o
// cadastro chama "SUCO DE CANA DE ACUCAR 1 LITRO". Casamos por CNPJ (cliente) e
// por código próprio / EAN (produto). O que não casar é recusado, nunca chutado.

import zlib from 'node:zlib';
import { eg, egTudo, erro } from './_egestor.js';
import { exigir } from './_sessao.js';

const CNPJ_VIVENDA = '23388480000105';
const TOLERANCIA = 0.02; // centavos de arredondamento

function soDigitos(s) { return String(s || '').replace(/\D/g, ''); }

// "1.234,56" -> 1234.56   |   "30,000" -> 30
function numeroBr(s) {
  return Number(String(s || '').replace(/\./g, '').replace(',', '.')) || 0;
}

function textoDoPdf(buf) {
  const pedacos = [];
  let i = 0;
  while (i < buf.length) {
    const ini = buf.indexOf('stream', i);
    if (ini < 0) break;
    let s = ini + 6;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const fim = buf.indexOf('endstream', s);
    if (fim < 0) break;
    i = fim + 9;

    let saida;
    try { saida = zlib.inflateSync(buf.subarray(s, fim)); } catch { continue; }
    const txt = saida.toString('latin1');
    if (!/BT|Tj|TJ/.test(txt)) continue; // não é fluxo de texto
    pedacos.push(txt);
  }

  // as strings desenhadas ficam entre parênteses
  const conteudo = pedacos.join('\n');
  const partes = [];
  const re = /\(((?:\\.|[^\\()])*)\)/g;
  let m;
  while ((m = re.exec(conteudo)) !== null) {
    partes.push(
      m[1]
        .replace(/\\n/g, ' ')
        .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\(.)/g, '$1')
    );
  }
  return partes.join(' ').replace(/\s+/g, ' ');
}

// Formato "PEDIDO DE COMPRAS" (Mateus): um PDF traz várias lojas.
//
// Cada pedido é   [cabeçalho] PEDIDO DE COMPRAS [corpo] Quantidade q v Vlr. TOTAL
// e se delimita sozinho pelo "Vlr. TOTAL", sem depender do nome da rede.
//
// Pegadinha: o cabeçalho de um pedido vem depois do "Vlr. TOTAL" do anterior e
// carrega junto os DADOS DA ENTREGA do anterior — com o CNPJ da loja anterior.
// Por isso valem sempre o ÚLTIMO CNPJ, o último nome e a última data antes do
// "PEDIDO DE COMPRAS".
function lerPedidosDeCompra(texto) {
  if (!/PEDIDO DE COMPRAS/.test(texto)) return null;

  const pedidos = [];
  let resto = texto;
  const re = /^([\s\S]*?)PEDIDO DE COMPRAS([\s\S]*?)Vlr\. TOTAL([\s\S]*)$/;

  let m;
  while ((m = resto.match(re)) !== null) {
    const [, cab, corpo, sobra] = m;
    resto = sobra;

    const cnpjs = (cab.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g) || [])
      .map(soDigitos)
      .filter((c) => c !== CNPJ_VIVENDA);
    const nomes = [...cab.matchAll(/(\d{1,3} - [A-Z][A-Za-z\s.\-]{4,}?)\s+\d{2}\.\d{3}\.\d{3}\//g)].map((x) => x[1]);
    const datas = [...cab.matchAll(/Data Entrega:\s*(\d{2}\/\d{2}\/\d{4})/g)].map((x) => x[1]);

    const itens = [];
    const reItem = /(\d{6})\s+(.+?)\s+\1\s*-\s*(\d{13})\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/g;
    let it;
    while ((it = reItem.exec(corpo)) !== null) {
      itens.push({
        codigoProprio: it[1],
        descricaoPedido: it[2].trim(),
        ean: it[3],
        qtd: Math.round(numeroBr(it[5])),
        preco: numeroBr(it[6]),
        total: numeroBr(it[7]),
      });
    }
    if (!itens.length) continue;

    const rodape = corpo.match(/Quantidade\s+([\d.,]+)\s+([\d.,]+)\s*$/);
    pedidos.push({
      loja: (nomes.length ? nomes[nomes.length - 1] : '').trim(),
      cnpj: cnpjs.length ? cnpjs[cnpjs.length - 1] : null,
      numero: (corpo.match(/PEDIDO DE N.MERO\s+(\d+)/) || [])[1] || null,
      entrega: datas.length ? datas[datas.length - 1] : null,
      itens,
      qtdDocumento: rodape ? Math.round(numeroBr(rodape[1])) : null,
      totalDocumento: rodape ? numeroBr(rodape[2]) : null,
    });
  }

  return pedidos.length ? pedidos : null;
}

// Confere as contas do próprio documento. Se não fecharem, não confiamos na leitura.
function conferir(p) {
  const problemas = [];
  for (const i of p.itens) {
    const esperado = Math.round(i.qtd * i.preco * 100) / 100;
    if (Math.abs(esperado - i.total) > TOLERANCIA) {
      problemas.push(`${i.codigoProprio}: ${i.qtd} x ${i.preco} daria ${esperado}, o documento diz ${i.total}`);
    }
  }
  const somaItens = Math.round(p.itens.reduce((s, i) => s + i.total, 0) * 100) / 100;
  if (p.totalDocumento != null && Math.abs(somaItens - p.totalDocumento) > TOLERANCIA) {
    problemas.push(`soma dos itens ${somaItens} não bate com o total ${p.totalDocumento}`);
  }
  const somaQtd = p.itens.reduce((s, i) => s + i.qtd, 0);
  if (p.qtdDocumento != null && somaQtd !== p.qtdDocumento) {
    problemas.push(`soma das quantidades ${somaQtd} não bate com ${p.qtdDocumento}`);
  }
  return problemas;
}

export default async function handler(req, res) {
  if (!exigir(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não suportado.' });

  try {
    const base64 = (req.body && req.body.arquivo) || '';
    if (!base64) throw erro(400, 'Anexe o arquivo do pedido.');

    const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.subarray(0, 5).toString() !== '%PDF-') {
      throw erro(400, 'Isso não parece um PDF. Por enquanto o app lê só PDF; foto ainda não.');
    }

    const texto = textoDoPdf(buf).replace(/\s+/g, ' ');
    if (texto.length < 200) {
      throw erro(422, 'Esse PDF não tem texto — parece ser digitalização ou foto. Lance esse pedido à mão.');
    }

    const brutos = lerPedidosDeCompra(texto);
    if (!brutos) {
      throw erro(422, 'Não reconheci o formato desse pedido. Por enquanto o app lê o "PEDIDO DE COMPRAS" do Mateus.');
    }

    // cadastro para casar por CNPJ e por código próprio
    const [contatos, produtos] = await Promise.all([
      egTudo('/contatos?fields=codigo,nome,cpfcnpj,bairro,cidade'),
      egTudo('/produtos?fields=codigo,descricao,codigoProprio,refEanGtin,precoVenda'),
    ]);
    const porCnpj = new Map(contatos.map((c) => [soDigitos(c.cpfcnpj), c]));
    const porProprio = new Map();
    const porEan = new Map();
    produtos.forEach((p) => {
      const cp = String(p.codigoProprio || '').trim();
      const ean = String(p.refEanGtin || '').trim();
      if (cp) porProprio.set(cp, p);
      if (ean) porEan.set(ean, p);
    });

    const pedidos = brutos.map((p) => {
      const cliente = porCnpj.get(p.cnpj) || null;
      const contas = conferir(p);

      const itens = p.itens.map((i) => {
        const prod = porProprio.get(i.codigoProprio) || porEan.get(i.ean) || null;
        return {
          codigoProprio: i.codigoProprio,
          ean: i.ean,
          descricaoPedido: i.descricaoPedido,
          qtd: i.qtd,
          precoPedido: i.preco,
          produto: prod ? { codigo: prod.codigo, descricao: prod.descricao, preco: Number(prod.precoVenda) || 0 } : null,
          divergePreco: prod ? Math.abs((Number(prod.precoVenda) || 0) - i.preco) > TOLERANCIA : false,
        };
      });

      const semProduto = itens.filter((i) => !i.produto);
      const impedimentos = [];
      if (!cliente) impedimentos.push(`Cliente com CNPJ ${p.cnpj} não está no cadastro do eGestor.`);
      semProduto.forEach((i) => impedimentos.push(`Produto ${i.codigoProprio} (${i.descricaoPedido}) não está no cadastro.`));
      contas.forEach((c) => impedimentos.push(`Conta do documento não fecha — ${c}.`));

      return {
        loja: p.loja,
        cnpj: p.cnpj,
        numero: p.numero,
        entrega: p.entrega,
        cliente: cliente ? { codigo: cliente.codigo, nome: cliente.nome, local: [cliente.bairro, cliente.cidade].filter(Boolean).join(' · ') } : null,
        itens,
        totalPedido: p.totalDocumento,
        aproveitavel: impedimentos.length === 0,
        impedimentos,
      };
    });

    return res.status(200).json({
      pedidos,
      prontos: pedidos.filter((p) => p.aproveitavel).length,
    });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
