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

// ---------- leitor de .xlsx ----------
// Um .xlsx é um ZIP de XMLs. Em vez de trazer uma dependência só para isso,
// lemos o diretório central do ZIP e inflamos as entradas que interessam —
// mesma linha do leitor de PDF acima, que também usa só o zlib do Node.
function entradasZip(buf) {
  const fim = buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (fim < 0) return null;
  const n = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  const mapa = new Map();
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const compr = buf.readUInt32LE(p + 20);
    const nomeLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comLen = buf.readUInt16LE(p + 32);
    const desloc = buf.readUInt32LE(p + 42);
    mapa.set(buf.subarray(p + 46, p + 46 + nomeLen).toString('utf8'), { metodo, compr, desloc });
    p += 46 + nomeLen + extraLen + comLen;
  }
  return mapa;
}

function extrairZip(buf, ent) {
  if (!ent) return null;
  const nomeLen = buf.readUInt16LE(ent.desloc + 26);
  const extraLen = buf.readUInt16LE(ent.desloc + 28);
  const ini = ent.desloc + 30 + nomeLen + extraLen;
  const dados = buf.subarray(ini, ini + ent.compr);
  try {
    return (ent.metodo === 0 ? dados : zlib.inflateRawSync(dados)).toString('utf8');
  } catch { return null; }
}

function desescapar(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Devolve as linhas da aba pedida como mapas {coluna -> texto}: { B:'...', C:'...' }
function linhasDaAba(buf, nomeAba) {
  const zip = entradasZip(buf);
  if (!zip) return null;

  const wb = extrairZip(buf, zip.get('xl/workbook.xml'));
  const rels = extrairZip(buf, zip.get('xl/_rels/workbook.xml.rels'));
  if (!wb || !rels) return null;

  const alvo = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const aba = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
    .find((m) => m[1].toUpperCase() === nomeAba.toUpperCase());
  if (!aba) return null;

  const xml = extrairZip(buf, zip.get('xl/' + alvo.get(aba[2]).replace(/^\//, '')));
  if (!xml) return null;

  // as strings de texto ficam num arquivo à parte, referenciadas por índice
  const ssXml = extrairZip(buf, zip.get('xl/sharedStrings.xml')) || '';
  const ss = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    desescapar([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))
  );

  return [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
    const cels = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const tipo = (c[2].match(/t="([^"]+)"/) || [, 'n'])[1];
      const v = c[3].match(/<v>([\s\S]*?)<\/v>/);
      let val;
      if (tipo === 's') val = ss[Number(v && v[1])] || '';
      else if (tipo === 'inlineStr') val = [...c[3].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('');
      else val = v ? v[1] : '';
      cels[c[1]] = desescapar(val).trim();
    }
    return cels;
  }).filter((l) => Object.values(l).some(Boolean));
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

// Formato "PEDIDO DE COMPRA" (LIDER): um pedido por arquivo.
//
// Item:  DESCRICAO  EMBALAGEM  COD/EAN  REFERENCIA  QTDE  PRECO ...  TOTAL
// A REFERENCIA de 6 dígitos é o nosso código próprio — o mesmo que o Mateus usa.
// O preço vem com 3 casas ("6,550") e as colunas do meio (desconto, despesas,
// IPI, frete) podem vir vazias, por isso o total é o último número da linha.
function lerPedidoDeCompra(texto) {
  if (!/PEDIDO DE COMPRA\b/.test(texto) || /PEDIDO DE COMPRAS/.test(texto)) return null;

  const cnpjs = (texto.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g) || [])
    .map(soDigitos)
    .filter((c) => c !== CNPJ_VIVENDA);
  if (!cnpjs.length) return null;

  const itens = [];
  const reItem = /([A-Z][A-Z0-9 .\/]{4,}?)\s+[A-Z]{2}\/\d+\s+[\d-]+\s+(\d{6})\s+(\d+)\s+([\d.,]+)\s+((?:[\d.,]+\s+){0,4})([\d.,]+)\s/g;
  let m;
  while ((m = reItem.exec(texto)) !== null) {
    itens.push({
      codigoProprio: m[2],
      descricaoPedido: m[1].trim(),
      ean: '',
      qtd: Math.round(numeroBr(m[3])),
      preco: numeroBr(m[4]),
      total: numeroBr(m[6]),
    });
  }
  if (!itens.length) return null;

  const emitente = (texto.match(/Emitente\s*:\s*(.+?)\s+\d+-\d/) || [])[1] || '';
  const cidade = (texto.match(/Cidade:\s*([A-Z ]+?)\s+[A-Z]{2}\s/) || [])[1] || '';

  return [{
    loja: [emitente.trim(), cidade.trim()].filter(Boolean).join(' - '),
    cnpj: cnpjs[0],
    numero: (texto.match(/Pedido:\s*([\d-]+)/) || [])[1] || null,
    entrega: (texto.match(/Entrega\s*:\s*(\d{2}\/\d{2}\/\d{2,4})/) || [])[1] || null,
    itens,
    qtdDocumento: (() => { const x = texto.match(/Total em unidades:\s*([\d.,]+)/); return x ? Math.round(numeroBr(x[1])) : null; })(),
    totalDocumento: (() => { const x = texto.match(/Total do Pedido:\s*([\d.,]+)/); return x ? numeroBr(x[1]) : null; })(),
  }];
}

// Relatório de produtos vendidos da FORMOSA — a base das notas com CFOP 5113.
//
// É uma tabela por filial. O PDF usa "x-none" como separador de célula, o que
// resolve a ambiguidade dos números (o texto vem com os caracteres espaçados).
// Linha vendida tem 5 células: nome, preço, quantidade, total, código.
// Linha sem venda tem 4 (falta a quantidade) e é ignorada.
//
// ⚠️ Os rótulos das filiais são desenhados DEPOIS das tabelas, em blocos — não
// intercalados. O pareamento é pela ordem, e por isso a tela EXIGE que a Tainara
// confirme a loja de cada tabela antes de virar pedido.
function lerRelatorioFormosa(bruto) {
  if (!/x-none/.test(bruto) || !/QUANTIDADE/.test(bruto.replace(/\s+/g, ''))) return null;

  const cel = bruto.split('x-none').map((c) => c.replace(/\s+/g, ''));
  const tabelas = [];
  const filiais = [];
  let atual = [];

  for (let i = 0; i < cel.length; i++) {
    const c = cel[i];

    const fil = c.match(/^FILIAL(.+?)M.SDE/);
    if (fil) { filiais.push(fil[1]); continue; }

    // "TOTAL:" com dois-pontos fecha a tabela; "TOTAL" sem eles é cabeçalho de coluna
    if (c === 'TOTAL:') {
      tabelas.push({ itens: atual, total: numeroBr((cel[i + 1] || '').replace(/^R\$/, '')) });
      atual = [];
      continue;
    }

    if (/^\d{6,7}-\d$/.test(c)) {
      const qtd = cel[i - 2] || '';
      if (!/^\d+,\d{4}$/.test(qtd)) continue; // sem quantidade = não vendeu
      atual.push({
        codigoFormosa: c,
        descricaoPedido: cel[i - 4] || '',
        ean: '',
        qtd: Math.round(numeroBr(qtd)),
        preco: numeroBr((cel[i - 3] || '').replace(/^R\$/, '')),
        total: numeroBr((cel[i - 1] || '').replace(/^R\$/, '')),
      });
    }
  }

  if (!tabelas.length) return null;

  return tabelas
    .map((t, n) => ({
      loja: filiais[n] || '',
      rotuloFormosa: filiais[n] || null,
      cnpj: null,
      numero: null,
      entrega: null,
      itens: t.itens,
      qtdDocumento: null,
      totalDocumento: t.total,
      confirmarLoja: true, // pareamento é por ordem: exige conferência humana
    }))
    .filter((p) => p.itens.length); // filial que não vendeu nada não vira pedido
}

// Planilha KARDEX do MATEUS (faturamento quinzenal da loja DOCA).
//
// A loja manda o que VENDEU no varejo na quinzena; a nota sai com 20% de
// desconto sobre o valor unitário. Confirmado contra a NF-e 13648 de 05/10/2026:
// os seis preços batem a três casas e o total fecha em R$ 4.877,64.
//
// Cuidado com as casas decimais: a coluna "Valor de Nota Unit" da planilha já
// traz os 20% mas arredondada a 2 casas, e isso erra o total (daria R$ 4.876,51
// naquela nota). Por isso o preço é recalculado aqui a partir da "Venda Liq.".
//
// As duas primeiras linhas depois do cabeçalho são totalizadores do pivô — a do
// fornecedor (nós) e a da filial. Só o que vem depois é produto.
const DESCONTO_KARDEX = 0.20;

function lerKardexMateus(buf) {
  const linhas = linhasDaAba(buf, 'KARDEX');
  if (!linhas || !linhas.length) return null;

  const iCab = linhas.findIndex((l) => /^FORNECEDOR$/i.test(l.B || ''));
  if (iCab < 0) return null;

  const corpo = linhas.slice(iCab + 1);
  // a primeira linha de dados tem que ser a nossa, senão não é esta planilha
  if (corpo.length < 3 || !/R\.?\s*T\.?\s*KALUME/i.test(corpo[0].B || '')) return null;

  const loja = corpo[1] || {};
  const periodo = (linhas[0] && linhas[0].B) || '';
  const itens = [];

  for (const l of corpo.slice(2)) {
    const rotulo = l.B || '';
    if (/^total/i.test(rotulo)) break;
    const m = rotulo.match(/^(\d+)\s*-\s*(.+)$/);
    if (!m) continue;

    const qtd = Math.round(Number(l.C) || 0);
    const vendaLiq = Math.round((Number(l.D) || 0) * 100) / 100;
    if (!qtd || !vendaLiq) continue;

    const varejo = vendaLiq / qtd;
    itens.push({
      codigoProprio: m[1],
      descricaoPedido: m[2].trim(),
      ean: '',
      qtd,
      preco: varejo,                                        // varejo, para conferir a conta
      total: vendaLiq,
      precoNota: Math.round(varejo * (1 - DESCONTO_KARDEX) * 1000) / 1000,
    });
  }

  if (!itens.length) return null;

  return [{
    loja: loja.B || '',
    cnpj: null,
    numero: null,
    entrega: periodo || null,
    itens,
    qtdDocumento: Math.round(Number(loja.C) || 0) || null,
    totalDocumento: Math.round((Number(loja.D) || 0) * 100) / 100 || null,
    // a planilha não traz CNPJ, só "223 - ... HIPER DOCAS": a loja é confirmada na tela
    confirmarLoja: true,
    codigoLojaMateus: ((loja.B || '').match(/^(\d+)\s*-/) || [, ''])[1],
    precoDoDocumento: true,
    descontoPct: DESCONTO_KARDEX * 100,
  }];
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
  const sessao = exigir(req, res);
  if (!sessao) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não suportado.' });

  try {
    const base64 = (req.body && req.body.arquivo) || '';
    if (!base64) throw erro(400, 'Anexe o arquivo do pedido.');

    const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
    const ehPdf = buf.subarray(0, 5).toString() === '%PDF-';
    const ehXlsx = buf.subarray(0, 2).toString('latin1') === 'PK';
    if (!ehPdf && !ehXlsx) {
      throw erro(400, 'Isso não parece um PDF nem uma planilha. O app lê PDF e .xlsx; foto ainda não.');
    }

    let brutos;
    if (ehXlsx) {
      // a planilha carrega a regra de preco do MATEUS; quem lanca por ela e a Tainara
      if (sessao.papel !== 'dona') {
        throw erro(403, 'A planilha é a Tainara quem lança. Aqui dá para anexar o PDF do pedido da loja.');
      }
      brutos = lerKardexMateus(buf);
      if (!brutos) {
        throw erro(422, 'Não reconheci essa planilha. Esperava o KARDEX do MATEUS, com a coluna FORNECEDOR e as linhas de produto logo abaixo.');
      }
    } else {
      const texto = textoDoPdf(buf).replace(/\s+/g, ' ');
      if (texto.length < 200) {
        throw erro(422, 'Esse PDF não tem texto — parece ser digitalização ou foto. Lance esse pedido à mão.');
      }
      brutos = lerPedidosDeCompra(texto) || lerPedidoDeCompra(texto) || lerRelatorioFormosa(texto);
      if (!brutos) {
        throw erro(422, 'Não reconheci o formato desse arquivo. O app lê o "PEDIDO DE COMPRAS" do Mateus, o "PEDIDO DE COMPRA" da LIDER e o relatório de produtos vendidos da FORMOSA.');
      }
    }

    // cadastro para casar cliente e produto
    const [contatos, produtos] = await Promise.all([
      egTudo('/contatos?fields=codigo,nome,cpfcnpj,bairro,cidade,obs'),
      egTudo('/produtos?fields=codigo,descricao,codigoProprio,refEanGtin,precoVenda,anotacoesInternas'),
    ]);
    const porCnpj = new Map(contatos.map((c) => [soDigitos(c.cpfcnpj), c]));
    const porProprio = new Map();
    const porEan = new Map();
    const porFormosaProd = new Map();
    produtos.forEach((p) => {
      const cp = String(p.codigoProprio || '').trim();
      const ean = String(p.refEanGtin || '').trim();
      if (cp) porProprio.set(cp, p);
      if (ean) porEan.set(ean, p);
      // o código da FORMOSA vive nas observações internas do produto
      const f = String(p.anotacoesInternas || '').match(/FORMOSA:\s*([\w.-]+)/i);
      if (f) porFormosaProd.set(f[1].trim(), p);
    });

    // rótulo da filial da FORMOSA vive nas observações do contato
    const porFormosaLoja = new Map();
    const lojasFormosa = [];
    contatos.forEach((c) => {
      const f = String(c.obs || '').match(/FORMOSA:\s*([\w. -]+)/i);
      if (!f) return;
      porFormosaLoja.set(f[1].trim().toUpperCase(), c);
      lojasFormosa.push({ codigo: c.codigo, nome: c.nome, rotulo: f[1].trim() });
    });

    // A planilha KARDEX não traz CNPJ, só "223 - ... HIPER DOCAS". Para adivinhar
    // menos, aceitamos um MATEUS:<código> nas observações do contato — mesma
    // convenção da FORMOSA — e, de todo jeito, a loja é confirmada na tela.
    const porCodigoMateus = new Map();
    const lojasMateus = [];
    contatos.forEach((c) => {
      if (!/^MATEUS SUPERMERCADOS/i.test(String(c.nome || ''))) return;
      lojasMateus.push({ codigo: c.codigo, nome: c.nome, rotulo: '' });
      const m = String(c.obs || '').match(/MATEUS:\s*(\d+)/i);
      if (m) porCodigoMateus.set(m[1], c);
    });

    const pedidos = brutos.map((p) => {
      const cliente = p.rotuloFormosa
        ? porFormosaLoja.get(String(p.rotuloFormosa).toUpperCase()) || null
        : p.codigoLojaMateus
          ? porCodigoMateus.get(p.codigoLojaMateus) || null
          : porCnpj.get(p.cnpj) || null;
      const contas = conferir(p);

      const itens = p.itens.map((i) => {
        const prod = (i.codigoFormosa ? porFormosaProd.get(i.codigoFormosa) : null)
          || porProprio.get(i.codigoProprio)
          || porEan.get(i.ean)
          || null;
        return {
          codigoProprio: i.codigoFormosa || i.codigoProprio,
          ean: i.ean,
          descricaoPedido: i.descricaoPedido,
          qtd: i.qtd,
          precoPedido: i.preco,
          // no KARDEX o preco da nota nasce do documento (varejo menos 20%), nao do cadastro
          precoNota: i.precoNota != null ? i.precoNota : null,
          produto: prod ? { codigo: prod.codigo, descricao: prod.descricao, preco: Number(prod.precoVenda) || 0 } : null,
          // so faz sentido cobrar igualdade com o cadastro quando a nota usa o preco do cadastro
          divergePreco: prod && !p.precoDoDocumento
            ? Math.abs((Number(prod.precoVenda) || 0) - i.preco) > TOLERANCIA
            : false,
        };
      });

      const semProduto = itens.filter((i) => !i.produto);
      const impedimentos = [];
      // na planilha a loja sai de um rótulo sem CNPJ: em vez de barrar, a tela pede
      // que ela escolha — o pedido só vira fila depois dessa escolha
      if (!cliente && !p.codigoLojaMateus) {
        impedimentos.push(p.rotuloFormosa
          ? `Filial "${p.rotuloFormosa}" não tem correspondência no cadastro. Ponha FORMOSA:${p.rotuloFormosa} nas observações do contato certo.`
          : `Cliente com CNPJ ${p.cnpj} não está no cadastro do eGestor.`);
      }
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
        // no relatório da FORMOSA a loja é deduzida pela ordem das tabelas:
        // a tela pede confirmação em vez de confiar nisso
        confirmarLoja: !!p.confirmarLoja,
        // a tela precisa saber que o preco vem do documento para nao usar o do cadastro
        precoDoDocumento: !!p.precoDoDocumento,
        descontoPct: p.descontoPct || 0,
        aproveitavel: impedimentos.length === 0,
        impedimentos,
      };
    });

    return res.status(200).json({
      pedidos,
      prontos: pedidos.filter((p) => p.aproveitavel).length,
      // opções para a Tainara corrigir a loja quando o pareamento é por ordem
      lojas: brutos.some((p) => p.codigoLojaMateus)
        ? lojasMateus
        : pedidos.some((p) => p.confirmarLoja) ? lojasFormosa : [],
    });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
