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

// ---------- extrator de texto COM POSIÇÃO ----------
//
// O textoDoPdf acima só serve para PDF cujo texto está em strings entre
// parênteses, na ordem de leitura. Relatórios de sistema (o do TOTVS da rede
// Cidade, por exemplo) quebram as duas coisas:
//
//  - o corpo da tabela usa fonte TrueType em subconjunto: os bytes da string são
//    códigos 1..58 que só viram letra pelo mapa /ToUnicode da fonte;
//  - a página sai girada (/Rotate 90) e cada coluna é um trecho separado, solto
//    por saltos enormes no TJ — a ordem do arquivo não é a ordem da tela.
//
// Aqui o conteúdo da página é interpretado de verdade: acompanhamos fonte,
// matriz de texto e CTM, decodificamos cada string pelo mapa da fonte, avançamos
// pela largura dos glifos para saber onde cada trecho cai, e só então
// devolvemos as LINHAS como a pessoa as vê, com as células em ordem.
//
// Só entra em cena quando os leitores de texto simples não reconhecem o arquivo.

function inflarSeguro(buf) {
  try { return zlib.inflateSync(buf); } catch { return null; }
}

// Todos os objetos do arquivo: os soltos e os que moram dentro de /ObjStm.
function objetosDoPdf(buf) {
  const s = buf.toString('latin1');
  const objs = new Map(); // numero -> { dic: texto, dados: Buffer|null }
  const re = /(\d+) 0 obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = Number(m[1]);
    const ini = re.lastIndex;
    const iStream = s.indexOf('stream', ini);
    const iFim = s.indexOf('endobj', ini);
    if (iFim < 0) break;
    const temStream = iStream >= 0 && iStream < iFim
      && s.slice(ini, iStream).trimEnd().endsWith('>>')
      && /^\r?\n/.test(s.slice(iStream + 6, iStream + 8));
    if (temStream) {
      // objeto com stream: o dado vai até o próximo endstream
      let d = iStream + 6;
      if (s[d] === '\r') d++;
      if (s[d] === '\n') d++;
      const iEnd = s.indexOf('endstream', d);
      if (iEnd < 0) break;
      objs.set(num, { dic: s.slice(ini, iStream), dados: buf.subarray(d, iEnd) });
      re.lastIndex = s.indexOf('endobj', iEnd) + 6;
    } else {
      objs.set(num, { dic: s.slice(ini, iFim), dados: null });
      re.lastIndex = iFim + 6;
    }
  }

  // objetos comprimidos dentro de /ObjStm
  for (const [, o] of [...objs]) {
    if (!o.dados || !/\/ObjStm/.test(o.dic)) continue;
    const d = inflarSeguro(o.dados);
    if (!d) continue;
    const t = d.toString('latin1');
    const first = Number((o.dic.match(/\/First\s+(\d+)/) || [])[1]);
    const cab = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < cab.length; i += 2) {
      const fim = i + 3 < cab.length ? first + cab[i + 3] : t.length;
      objs.set(cab[i], { dic: t.slice(first + cab[i + 1], fim), dados: null });
    }
  }
  return objs;
}

function refDe(txt, chave) {
  const m = String(txt || '').match(new RegExp('/' + chave + '\\s+(\\d+)\\s+0\\s+R'));
  return m ? Number(m[1]) : null;
}

// Devolve o conteúdo de um << ... >> a partir da posição de abertura, com aninhamento.
function dicionarioBalanceado(txt, desde) {
  let prof = 0;
  for (let i = desde; i < txt.length - 1; i++) {
    if (txt[i] === '<' && txt[i + 1] === '<') { prof++; i++; }
    else if (txt[i] === '>' && txt[i + 1] === '>') {
      prof--; i++;
      if (prof === 0) return txt.slice(desde + 2, i - 1);
    }
  }
  return '';
}

// O valor de uma chave que pode vir inline (<< ... >>) ou por referência (N 0 R).
function valorDicionario(objs, txt, chave) {
  const re = new RegExp('/' + chave + '\\s*(<<|(\\d+)\\s+0\\s+R)');
  const m = String(txt || '').match(re);
  if (!m) return null;
  if (m[1] === '<<') return dicionarioBalanceado(txt, m.index + m[0].length - 2);
  const o = objs.get(Number(m[2]));
  if (!o) return null;
  const t = o.dic.trim();
  return t.startsWith('<<') ? dicionarioBalanceado(t, 0) : t;
}

function cmapDe(objs, num) {
  const o = num != null ? objs.get(num) : null;
  if (!o || !o.dados) return null;
  const d = inflarSeguro(o.dados);
  if (!d) return null;
  const t = d.toString('latin1');
  const mapa = new Map();
  const u16 = (hex) => String.fromCharCode(parseInt(hex.slice(0, 4), 16));

  const faixa = (t.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/) || [])[1];
  const bytes = faixa ? Math.max(1, faixa.length / 2) : 1;

  for (const blk of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
      if (r[3] !== undefined) {
        const base = parseInt(r[3].slice(0, 4), 16);
        for (let k = lo; k <= hi && k - lo < 70000; k++) mapa.set(k, String.fromCharCode(base + (k - lo)));
      } else {
        const alvos = [...r[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => u16(x[1]));
        alvos.forEach((a, k) => mapa.set(lo + k, a));
      }
    }
  }
  for (const blk of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const r of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) mapa.set(parseInt(r[1], 16), u16(r[2]));
  }
  return { mapa, bytes };
}

function larguras(objs, txt) {
  let lista = null;
  const ref = String(txt).match(/\/Widths\s+(\d+)\s+0\s+R/);
  const corpo = ref ? (objs.get(Number(ref[1])) || {}).dic : String(txt);
  const m = String(corpo || '').match(/\/Widths\s*\[([^\]]*)\]/) || String(corpo || '').match(/^\s*\[([^\]]*)\]/);
  if (m) lista = m[1].trim().split(/\s+/).map(Number);
  return lista || [];
}

function fonteDe(objs, num) {
  const o = objs.get(num);
  if (!o) return null;
  const txt = o.dic;
  return {
    cmap: cmapDe(objs, refDe(txt, 'ToUnicode')),
    primeiro: Number((txt.match(/\/FirstChar\s+(\d+)/) || [, 0])[1]),
    larg: larguras(objs, txt),
    padrao: Number((txt.match(/\/MissingWidth\s+(\d+)/) || [, 500])[1]) || 500,
  };
}

// ---- interpretador do conteúdo ----
const BARRA = String.fromCharCode(92);

function* tokensConteudo(s) {
  let i = 0;
  const n = s.length;
  const ESP = ' \t\r\n\x00\f';
  const FIMTOK = ' \t\r\n\x00\f()<>[]/%';
  while (i < n) {
    const c = s[i];
    if (ESP.includes(c)) { i++; continue; }
    if (c === '%') { while (i < n && s[i] !== '\r' && s[i] !== '\n') i++; continue; }
    if (c === '(') {
      let prof = 1, j = i + 1, out = '';
      while (j < n && prof) {
        const ch = s[j];
        if (ch === BARRA) {
          j++;
          const e = s[j];
          if (e >= '0' && e <= '7') {
            let o = e;
            for (let k = 0; k < 2; k++) if (j + 1 < n && s[j + 1] >= '0' && s[j + 1] <= '7') { j++; o += s[j]; }
            out += String.fromCharCode(parseInt(o, 8) & 255);
          } else if (e === 'n') out += '\n';
          else if (e === 'r') out += '\r';
          else if (e === 't') out += '\t';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === '\r' || e === '\n') { /* continuação de linha */ }
          else out += e;
        } else if (ch === '(') { prof++; out += ch; }
        else if (ch === ')') { prof--; if (prof) out += ch; }
        else out += ch;
        j++;
      }
      yield ['s', out]; i = j; continue;
    }
    if (c === '<' && s[i + 1] !== '<') {
      const j = s.indexOf('>', i);
      let hx = s.slice(i + 1, j).replace(/\s/g, '');
      if (hx.length % 2) hx += '0';
      let out = '';
      for (let k = 0; k < hx.length; k += 2) out += String.fromCharCode(parseInt(hx.slice(k, k + 2), 16));
      yield ['s', out]; i = j + 1; continue;
    }
    if (c === '[' || c === ']') { yield [c, c]; i++; continue; }
    if ((c === '<' || c === '>') && s[i + 1] === c) { i += 2; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !FIMTOK.includes(s[j])) j++;
      yield ['n', s.slice(i + 1, j)]; i = j; continue;
    }
    let j = i;
    while (j < n && !FIMTOK.includes(s[j])) j++;
    if (j === i) { i++; continue; }
    const w = s.slice(i, j); i = j;
    const num = Number(w);
    yield Number.isNaN(num) ? ['o', w] : ['x', num];
  }
}

function mult(a, b) { // aplica a e depois b
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

// Trechos de texto de uma página: { x, y, t, tam } em coordenadas de TELA (já com /Rotate).
function trechosDaPagina(objs, pagina) {
  const dicPagina = pagina.dic;
  let rot = Number((dicPagina.match(/\/Rotate\s+(-?\d+)/) || [, 0])[1]);
  if (!rot) {
    const pai = objs.get(refDe(dicPagina, 'Parent'));
    if (pai) rot = Number((pai.dic.match(/\/Rotate\s+(-?\d+)/) || [, 0])[1]);
  }
  rot = ((rot % 360) + 360) % 360;

  const recursos = valorDicionario(objs, dicPagina, 'Resources') || '';
  const dicFontes = valorDicionario(objs, recursos, 'Font') || '';
  const fontes = new Map();
  for (const f of dicFontes.matchAll(/\/([\w.+-]+)\s+(\d+)\s+0\s+R/g)) {
    const fonte = fonteDe(objs, Number(f[2]));
    if (fonte) fontes.set(f[1], fonte);
  }

  const lista = (dicPagina.match(/\/Contents\s*\[([^\]]*)\]/) || [])[1];
  const nums = lista
    ? [...lista.matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]))
    : [refDe(dicPagina, 'Contents')].filter((x) => x != null);
  let conteudo = '';
  for (const n of nums) {
    const o = objs.get(n);
    const d = o && o.dados ? inflarSeguro(o.dados) : null;
    if (d) conteudo += d.toString('latin1') + '\n';
  }

  const trechos = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const pilha = [];
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm;
  let fonte = null, tamFonte = 1, entrelinha = 0;
  let st = [];

  const decodificar = (f, str) => {
    if (f && f.cmap) {
      const { mapa, bytes } = f.cmap;
      let out = '';
      for (let k = 0; k + bytes <= str.length; k += bytes) {
        let cod = 0;
        for (let b = 0; b < bytes; b++) cod = cod * 256 + str.charCodeAt(k + b);
        out += mapa.has(cod) ? mapa.get(cod) : '';
      }
      return out;
    }
    return str;
  };
  const largura = (f, cod) => {
    if (!f) return 500;
    const k = cod - f.primeiro;
    return k >= 0 && k < f.larg.length && f.larg[k] ? f.larg[k] : f.padrao;
  };

  const emitir = (itens) => {
    const f = fonte;
    const base = mult(tm, ctm);
    const passo = Math.hypot(base[0], base[1]) || 1;
    let desl = 0, iniSeg = 0, seg = '';
    const fechar = () => {
      if (seg.trim()) {
        const p = mult([1, 0, 0, 1, iniSeg, 0], base);
        trechos.push({ x: p[4], y: p[5], t: seg, tam: Math.abs(tamFonte * passo) });
      }
      seg = '';
    };
    const bytes = f && f.cmap ? f.cmap.bytes : 1;
    for (const it of itens) {
      if (typeof it === 'string') {
        if (!seg) iniSeg = desl;
        for (let k = 0; k + bytes <= it.length; k += bytes) {
          let cod = 0;
          for (let b = 0; b < bytes; b++) cod = cod * 256 + it.charCodeAt(k + b);
          desl += largura(f, cod) * tamFonte / 1000;
        }
        seg += decodificar(f, it);
      } else if (Math.abs(it) > 1500) {   // salto de coluna: o que vem depois é outra célula
        fechar(); desl -= it * tamFonte / 1000;
      } else {
        desl -= it * tamFonte / 1000;
        if (it < -150 && seg) seg += ' ';  // espaço entre palavras
      }
    }
    fechar();
    tm = mult([1, 0, 0, 1, desl, 0], tm);
  };

  for (const [tipo, v] of tokensConteudo(conteudo)) {
    if (tipo === 'o') {
      switch (v) {
        case 'q': pilha.push(ctm.slice()); break;
        case 'Q': if (pilha.length) ctm = pilha.pop(); break;
        case 'cm': if (st.length >= 6) ctm = mult(st.slice(-6), ctm); break;
        case 'BT': tm = tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'Tf': fonte = fontes.get(st[st.length - 2]) || null; tamFonte = st[st.length - 1]; break;
        case 'Tm': if (st.length >= 6) tm = tlm = st.slice(-6); break;
        case 'Td': case 'TD': {
          const tx = st[st.length - 2], ty = st[st.length - 1];
          tlm = mult([1, 0, 0, 1, tx, ty], tlm); tm = tlm;
          if (v === 'TD') entrelinha = -ty;
          break;
        }
        case 'T*': tlm = mult([1, 0, 0, 1, 0, -entrelinha], tlm); tm = tlm; break;
        case 'TL': entrelinha = st[st.length - 1]; break;
        case 'Tj': emitir([st[st.length - 1]]); break;
        case 'TJ': emitir(Array.isArray(st[st.length - 1]) ? st[st.length - 1] : []); break;
        default: break;
      }
      st = [];
    } else if (tipo === '[') st.push('[');
    else if (tipo === ']') {
      let j = st.length - 1;
      while (j >= 0 && st[j] !== '[') j--;
      const arr = st.slice(j + 1);
      st = st.slice(0, Math.max(j, 0)); st.push(arr);
    } else st.push(v);
  }

  // coordenadas de tela: o visualizador gira a página /Rotate graus no sentido horário
  const girar = {
    0: (x, y) => [x, y],
    90: (x, y) => [y, -x],
    180: (x, y) => [-x, -y],
    270: (x, y) => [-y, x],
  }[rot] || ((x, y) => [x, y]);
  return trechos.map((t) => {
    const [X, Y] = girar(t.x, t.y);
    return { x: X, y: Y, t: t.t, tam: t.tam };
  });
}

// Linhas como a pessoa vê (de cima para baixo), cada uma com as células da esquerda para a direita.
function linhasPosicionadas(buf) {
  const objs = objetosDoPdf(buf);
  const ehPagina = (o) => /\/Type\s*\/Page\b(?!s)/.test(o.dic);

  // ordem de leitura = ordem da árvore /Pages -> /Kids, não a numeração dos objetos
  const emOrdem = [];
  const visitados = new Set();
  const descer = (num) => {
    const o = objs.get(num);
    if (!o || visitados.has(num)) return;
    visitados.add(num);
    if (ehPagina(o)) { emOrdem.push(o); return; }
    const kids = (o.dic.match(/\/Kids\s*\[([^\]]*)\]/) || [])[1];
    if (kids) for (const k of kids.matchAll(/(\d+)\s+0\s+R/g)) descer(Number(k[1]));
  };
  const catalogo = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dic));
  if (catalogo) descer(refDe(catalogo.dic, 'Pages'));

  const paginas = emOrdem.length
    ? emOrdem
    : [...objs.entries()].filter(([, o]) => ehPagina(o)).sort((a, b) => a[0] - b[0]).map(([, o]) => o);

  const todas = [];
  for (const pag of paginas) {
    const tr = trechosDaPagina(objs, pag);
    if (!tr.length) continue;
    const tams = tr.map((t) => t.tam).sort((a, b) => a - b);
    const tol = Math.max(0.4 * (tams[Math.floor(tams.length / 2)] || 6), 1);
    const ordenados = tr.slice().sort((a, b) => b.y - a.y); // topo primeiro
    const linhas = [];
    for (const t of ordenados) {
      const ult = linhas[linhas.length - 1];
      if (ult && Math.abs(ult.y - t.y) <= tol) ult.cel.push(t);
      else linhas.push({ y: t.y, cel: [t] });
    }
    for (const l of linhas) {
      l.cel.sort((a, b) => a.x - b.x);
      todas.push(l.cel.map((c) => c.t.replace(/\s+/g, ' ').trim()).filter(Boolean));
    }
  }
  return todas.filter((l) => l.length);
}

// Relatório "ANÁLISE ABC DE VENDAS - VAREJO" da rede CIDADE (sistema TOTVS Varejo).
//
// É o que a loja VENDEU do nosso produto no período — não é pedido de compra, e
// por isso só a Tainara lança. Vem por loja ("Empresa: 1 - 01-PEDREIRA"), com a
// quantidade de cada produto e subtotal por loja.
//
// O que o relatório NÃO traz, e por isso não dá para tirar dele:
//  - CNPJ: a loja vem só pelo rótulo ("01-PEDREIRA");
//  - preço: as colunas de valor saem vazias, então a nota usa o preço do cadastro;
//  - o nosso código de produto: vem o código do produto NO SISTEMA DELES
//    (156655), que não é o nosso — daí o mapa CIDADE_PRODUTO abaixo.
//
// A identificação segue a regra do projeto: por código, nunca por nome. O que não
// casar é recusado, não chutado.

// código do produto na Cidade -> `codigo` interno do produto no eGestor.
// Produto novo entra sem mexer aqui: basta pôr CIDADE:<código> nas observações
// internas do produto, no eGestor (mesma convenção da FORMOSA).
const CIDADE_PRODUTO = {
  '156655': 3, // SUCO CANA DAMOENDA 1L             -> SUCO DE CANA DE ACUCAR 1 LITRO
  '156663': 1, // SUCO CANA DAMOENDA 330ML          -> SUCO DE CANA DE ACUCAR 330ML
  '209538': 6, // SUCO CANA DAMOENDA C/ LIMAO 1L    -> ... COM LIMÃO 1 LITRO
  '209511': 4, // SUCO CANA DAMOENDA C/ LIMAO 330ML -> ... COM LIMÃO 330ML
  '209520': 5, // SUCO CANA DAMOENDA C/ LIMAO 500ML -> ... COM LIMÃO 500ML
};

// rótulo da loja (sem o número da frente) -> CNPJ no cadastro do eGestor.
// Loja nova entra pondo CIDADE:<ROTULO> nas observações do contato.
const CIDADE_LOJA_CNPJ = {
  PEDREIRA: '83306969000112', // SUPERMERCADO CIDADE LTDA - PEDREIRA
  PVARGAS: '83306969000546',  // SUPERMERCADO CIDADE LTDA - PRESIDENTE VARGAS
};

// "01-PEDREIRA" -> "PEDREIRA"
function chaveLojaCidade(rotulo) {
  return String(rotulo || '').replace(/^\d+\s*-\s*/, '').replace(/\s+/g, '').toUpperCase();
}

const RE_QTD_CIDADE = /^\d{1,3}(?:\.\d{3})*,\d{3}$/; // quantidade tem 3 casas; valor em dinheiro tem 2

function lerRelatorioCidade(linhas) {
  const todo = linhas.map((l) => l.join(' ')).join('\n');
  if (!/AN.LISE ABC DE VENDAS/i.test(todo) || !/Fornecedores\s*:/i.test(todo) || !/KALUME/i.test(todo)) return null;

  const per = todo.match(/(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/);
  const periodo = per ? `${per[1]} a ${per[2]}` : null;

  const lojas = [];
  let atual = null;
  for (const l of linhas) {
    const txt = l.join(' ').replace(/\s+/g, ' ').trim();

    const emp = txt.match(/^Empresa:\s*(\d+)\s*-\s*(.+)$/i); // "Empresa(s):" não casa: falta o ":" colado
    if (emp) {
      // uma loja que passa de uma página reaparece com o mesmo cabeçalho: junta, não duplica
      atual = lojas.find((x) => x.numero === emp[1]);
      if (!atual) { atual = { numero: emp[1], rotulo: emp[2].trim(), itens: [], subtotal: null }; lojas.push(atual); }
      continue;
    }
    if (!atual) continue;

    if (/^Sub\s*Total\s*Empresa:/i.test(txt)) {
      const q = l.map((c) => c.trim()).find((c) => RE_QTD_CIDADE.test(c));
      if (q) atual.subtotal = numeroBr(q);
      continue;
    }

    // Pos. | Cód. | Produto | Embal | Quantidade — lido pela linha inteira, sem
    // depender de como as células foram cortadas
    const it = txt.match(/^(\d+)\s+(\d{4,})\s+(.+?)\s+[A-Z]{2}\s*\d*\s+(\d{1,3}(?:\.\d{3})*,\d{3})\b/);
    if (it) {
      atual.itens.push({
        codigoProprio: it[2],
        descricaoPedido: it[3].trim(),
        ean: '',
        qtd: Math.round(numeroBr(it[4])),
        preco: null,
        total: null,
      });
    }
  }

  // "5 de 6 Produto(s) Listado(s)": se a lista saiu menor que o universo, falta linha
  const avisos = [];
  const lis = todo.match(/(\d+)\s+de\s+(\d+)\s+Produto\(s\)\s+Listado/i);
  if (lis && Number(lis[1]) < Number(lis[2])) {
    avisos.push(`O relatório diz que listou só ${lis[1]} de ${lis[2]} produtos — ${Number(lis[2]) - Number(lis[1])} ficou de fora. Confira com a Cidade se não faltou venda.`);
  }

  const comItens = lojas.filter((x) => x.itens.length);
  if (!comItens.length) return null;

  return comItens.map((x) => ({
    loja: x.rotulo,
    rotuloCidade: chaveLojaCidade(x.rotulo),
    cnpj: null,
    numero: null,
    entrega: null,
    periodo,
    itens: x.itens,
    qtdDocumento: x.subtotal,
    totalDocumento: null,
    confirmarLoja: false, // o rótulo é explícito, não deduzido por ordem como no relatório da FORMOSA
    semPreco: true,
    avisos,
  }));
}

// Confere as contas do próprio documento. Se não fecharem, não confiamos na leitura.
function conferir(p) {
  const problemas = [];
  // documento sem preço (relatório de vendas da Cidade): não há conta de valor a
  // conferir, só a de quantidades, logo abaixo
  if (!p.semPreco) {
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

      // Primeiro os leitores de texto simples, que já funcionavam e não mudam.
      brutos = texto.length >= 200
        ? lerPedidosDeCompra(texto) || lerPedidoDeCompra(texto) || lerRelatorioFormosa(texto)
        : null;

      // Só se nenhum reconheceu é que entra o extrator com posição — para PDF de
      // sistema, com fonte em subconjunto e página girada. Texto curto no leitor
      // simples não quer dizer "sem texto": pode estar todo em fonte com mapa.
      if (!brutos) {
        let linhas = [];
        try { linhas = linhasPosicionadas(buf); } catch { linhas = []; }
        if (linhas.length) brutos = lerRelatorioCidade(linhas);
        else if (texto.length < 200) {
          throw erro(422, 'Esse PDF não tem texto — parece ser digitalização ou foto. Lance esse pedido à mão.');
        }
      }
      if (!brutos) {
        throw erro(422, 'Não reconheci o formato desse arquivo. O app lê o "PEDIDO DE COMPRAS" do Mateus, o "PEDIDO DE COMPRA" da LIDER, o relatório de produtos vendidos da FORMOSA e o relatório de vendas da rede CIDADE.');
      }

      // o relatório da Cidade é o que a loja vendeu, e quem fatura é a Tainara
      if (brutos.some((p) => p.rotuloCidade) && sessao.papel !== 'dona') {
        throw erro(403, 'O relatório de vendas da Cidade é a Tainara quem lança. Aqui dá para anexar o PDF do pedido da loja.');
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
    const porCidadeProd = new Map();
    const porCodigo = new Map(produtos.map((p) => [Number(p.codigo), p]));
    produtos.forEach((p) => {
      const cp = String(p.codigoProprio || '').trim();
      const ean = String(p.refEanGtin || '').trim();
      if (cp) porProprio.set(cp, p);
      if (ean) porEan.set(ean, p);
      // o código da FORMOSA vive nas observações internas do produto
      const f = String(p.anotacoesInternas || '').match(/FORMOSA:\s*([\w.-]+)/i);
      if (f) porFormosaProd.set(f[1].trim(), p);
      // o da CIDADE também; sem isso vale o mapa CIDADE_PRODUTO do código
      const c = String(p.anotacoesInternas || '').match(/CIDADE:\s*([\w.-]+)/i);
      if (c) porCidadeProd.set(c[1].trim(), p);
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

    // O rótulo da loja da CIDADE ("PEDREIRA") vira cliente por CIDADE:<ROTULO> nas
    // observações do contato ou, na falta, pelo CNPJ da tabela CIDADE_LOJA_CNPJ.
    const porCidadeLoja = new Map();
    contatos.forEach((c) => {
      const f = String(c.obs || '').match(/CIDADE:\s*([\w. -]+)/i);
      if (f) porCidadeLoja.set(chaveLojaCidade(f[1]), c);
    });

    const pedidos = brutos.map((p) => {
      const cliente = p.rotuloCidade
        ? porCidadeLoja.get(p.rotuloCidade) || porCnpj.get(CIDADE_LOJA_CNPJ[p.rotuloCidade]) || null
        : p.rotuloFormosa
          ? porFormosaLoja.get(String(p.rotuloFormosa).toUpperCase()) || null
          : p.codigoLojaMateus
            ? porCodigoMateus.get(p.codigoLojaMateus) || null
            : porCnpj.get(p.cnpj) || null;
      const contas = conferir(p);

      const itens = p.itens.map((i) => {
        const prod = (i.codigoFormosa ? porFormosaProd.get(i.codigoFormosa) : null)
          || (p.rotuloCidade
            ? porCidadeProd.get(i.codigoProprio) || porCodigo.get(CIDADE_PRODUTO[i.codigoProprio]) || null
            : null)
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
        impedimentos.push(p.rotuloCidade
          // aqui a loja vem por rótulo explícito, não por ordem: sem correspondência
          // é recusa, não escolha — escolher poderia emitir nota para a loja errada
          ? `A loja "${p.loja}" não tem correspondência no cadastro. Cadastre-a no eGestor e ponha CIDADE:${p.rotuloCidade} nas observações do contato.`
          : p.rotuloFormosa
            ? `Filial "${p.rotuloFormosa}" não tem correspondência no cadastro. Ponha FORMOSA:${p.rotuloFormosa} nas observações do contato certo.`
            : `Cliente com CNPJ ${p.cnpj} não está no cadastro do eGestor.`);
      }
      semProduto.forEach((i) => impedimentos.push(p.rotuloCidade
        ? `Produto ${i.codigoProprio} (${i.descricaoPedido}) sem correspondência. Ponha CIDADE:${i.codigoProprio} nas observações internas do produto certo no eGestor.`
        : `Produto ${i.codigoProprio} (${i.descricaoPedido}) não está no cadastro.`));
      contas.forEach((c) => impedimentos.push(`Conta do documento não fecha — ${c}.`));

      return {
        loja: p.loja,
        cnpj: p.cnpj,
        numero: p.numero,
        entrega: p.entrega,
        periodo: p.periodo || null,
        // o documento não traz preço: a nota sai pelo do cadastro, e a tela avisa
        semPreco: !!p.semPreco,
        avisos: p.avisos || [],
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
