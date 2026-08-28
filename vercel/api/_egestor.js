// Ponte com a API do eGestor. O personal_token vive só aqui, no servidor —
// nunca chega ao navegador do Jean nem da Tainara.

const API = 'https://api.egestor.com.br/api';
export const TAG_APP = 'APP_PEDIDOS';
export const COD_VENDEDOR = 3; // Tainara

// o access_token dura 900s; guardamos por 800s enquanto a lambda estiver quente
let sessao = { token: null, expira: 0 };

async function acessar() {
  if (sessao.token && Date.now() < sessao.expira) return sessao.token;

  const personal = process.env.EGESTOR_PERSONAL_TOKEN;
  if (!personal) throw erro(500, 'EGESTOR_PERSONAL_TOKEN não está configurado na Vercel.');

  const r = await fetch(`${API}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'personal', personal_token: personal }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) {
    throw erro(502, 'Não consegui entrar no eGestor. Confira o token nas variáveis da Vercel.');
  }
  sessao = { token: j.access_token, expira: Date.now() + 800 * 1000 };
  return sessao.token;
}

export function erro(status, mensagem, detalhe) {
  const e = new Error(mensagem);
  e.status = status;
  e.detalhe = detalhe;
  return e;
}

export async function eg(metodo, caminho, corpo) {
  const token = await acessar();
  const r = await fetch(`${API}/v1${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });

  if (r.status === 429) throw erro(429, 'O eGestor pediu para desacelerar. Espere alguns segundos.');

  const texto = await r.text();
  let j;
  try { j = JSON.parse(texto); } catch { j = null; }

  if (j && j.errCode) {
    throw erro(r.status === 200 ? 400 : r.status, j.errMsg || 'O eGestor recusou a operação.', j);
  }
  if (!r.ok) throw erro(r.status, `O eGestor respondeu ${r.status}.`, texto.slice(0, 300));
  return j;
}

// listagens vêm paginadas em 50; junta tudo
export async function egTudo(caminho, maxPaginas = 6) {
  const sep = caminho.includes('?') ? '&' : '?';
  let pagina = 1;
  const todos = [];
  while (pagina <= maxPaginas) {
    const r = await eg('GET', `${caminho}${sep}page=${pagina}`);
    if (r && Array.isArray(r.data)) todos.push(...r.data);
    const ultima = r && r.last_page ? r.last_page : 1;
    if (pagina >= ultima) break;
    pagina++;
  }
  return todos;
}

// ---- regra de CFOP ----
// Decidida no servidor, no momento em que o pedido é criado. Não vem do
// navegador e não é escolhida na autorização.
//
// A FORMOSA trabalha em consignação: o Jean remete a mercadoria (5917, sem
// imposto) e a Tainara fatura depois o que já foi remetido (5113, com imposto).
// Qualquer outro cliente é venda normal, 5401.
export function cfopPara(nomeCliente, papel) {
  const ehFormosa = /FORMOSA/i.test(String(nomeCliente || ''));
  if (!ehFormosa) return '5401';
  return papel === 'dona' ? '5113' : '5917';
}

// O CFOP da nota vem do GRUPO DE TRIBUTOS da linha do produto na venda, e esse
// grupo só se troca pela tela do eGestor (a API recusa `codConfigTrib` no POST).
//
// Grupos cadastrados nesta conta:
//   1 - Tributação padrão            -> x401  (é o default de todo produto)
//   2 - REMESSA DE MERCADORIA        -> x917  (ICMS 40, PIS/COFINS 07, sem imposto)
//   3 - VENDA REMETIDA ANTERIORMENTE -> x113  (tributa igual ao grupo 1)
export const GRUPO_DE_CFOP = {
  5401: '1 - Tributação padrão',
  5917: '2 - REMESSA DE MERCADORIA',
  5113: '3 - VENDA REMETIDA ANTERIORMENTE',
};

export const COD_GRUPO_DE_CFOP = { 5401: 1, 5917: 2, 5113: 3 };
export const GRUPO_PADRAO = 1;

// A venda FOTOGRAFA o grupo de tributos do produto no instante em que é criada:
// mudar o produto depois não mexe nas vendas já feitas (verificado em 28/08/2026).
// É isso que permite lançar um pedido com o CFOP certo sem ninguém trocar nada
// na tela: colocamos os produtos no grupo desejado, criamos a venda, e devolvemos
// os produtos ao grupo padrão.
export async function gruposAtuaisDosProdutos() {
  const lista = await egTudo('/produtos?fields=codigo,codigoGrupoTributos');
  const mapa = new Map();
  lista.forEach((p) => mapa.set(Number(p.codigo), Number(p.codigoGrupoTributos)));
  return mapa;
}

// Põe no grupo pedido só os produtos que ainda não estão nele. Devolve quais
// foram mexidos, para poder desfazer depois.
export async function porNoGrupo(codigos, grupo) {
  const atuais = await gruposAtuaisDosProdutos();
  const mexidos = [];
  for (const cod of codigos) {
    if (atuais.get(Number(cod)) === Number(grupo)) continue;
    await eg('PUT', `/produtos/${cod}`, { codigoGrupoTributos: Number(grupo) });
    mexidos.push(Number(cod));
  }
  return mexidos;
}

export async function devolverAoPadrao(codigos) {
  for (const cod of codigos) {
    try {
      await eg('PUT', `/produtos/${cod}`, { codigoGrupoTributos: GRUPO_PADRAO });
    } catch {
      // Se falhar, o produto fica no grupo errado. Não emite nota errada: a
      // conferência de CFOP na autorização barra antes de transmitir.
    }
  }
}

// Lê o CFOP que está DE FATO aplicado em cada linha, pelo relatório de produtos
// vendidos — o único lugar da API que expõe isso. Uma chamada cobre a fila toda.
export async function cfopsAplicados(diasParaTras = 90) {
  const fmt = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Belem' });
  const linhas = await eg('POST', '/relatorios/detalhesProdutosVendidos', {
    tipoData: 'dtCad',
    de: fmt(new Date(Date.now() - diasParaTras * 24 * 3600 * 1000)),
    ate: fmt(new Date()),
    tags: TAG_APP,
    mostrarCFOP: true,
    mostrarGrupoTrib: true,
    mostrarAbertas: true,
  });

  const porVenda = {};
  (Array.isArray(linhas) ? linhas : []).forEach((l) => {
    const v = String(l.venda);
    if (!porVenda[v]) porVenda[v] = [];
    porVenda[v].push(String(l.cfop || ''));
  });
  return porVenda;
}

// O relatório devolve o CFOP no formato "x401"; o x é o dígito que varia por
// destino (5 dentro do estado). Comparamos só o sufixo.
export function podeEmitirPelaApi(cfopEsperado, cfopsDaVenda) {
  const esperado = String(cfopEsperado);
  const alvo = 'x' + esperado.slice(1);
  const linhas = cfopsDaVenda || [];

  if (!linhas.length) {
    return { pode: false, motivo: 'Não consegui ler o grupo de tributos desta venda. Confira no eGestor antes de emitir.' };
  }

  const aplicado = linhas[0];
  const uniforme = linhas.every((c) => c === aplicado);

  if (!uniforme) {
    return { pode: false, motivo: 'Os produtos desta venda estão em grupos de tributos diferentes. Deixe todos no mesmo grupo antes de autorizar.' };
  }
  if (aplicado === alvo) return { pode: true, cfopAplicado: aplicado };

  const grupo = GRUPO_DE_CFOP[esperado];
  return {
    pode: false,
    cfopAplicado: aplicado,
    motivo:
      `Esta venda está no grupo de tributos que gera CFOP ${aplicado.replace('x', '5')}, ` +
      `mas deveria sair ${esperado}. No eGestor, abra o orçamento, clique na engrenagem ao ` +
      `lado de cada produto e troque o grupo para "${grupo}". Depois volte e autorize.`,
  };
}

// ---- observações do pedido: quem lançou e qual CFOP ----
// Gravado em customizado.xCampo1 ("Observações gerais" no eGestor), porque é o
// único campo que a API deixa alterar depois que a venda existe.
export function montarObs({ por, cfop, nota }) {
  const partes = [`APP`, `por ${por || '?'}`, `CFOP ${cfop || '5401'}`];
  if (nota) partes.push(nota);
  return partes.join(' | ');
}

export function lerObs(texto) {
  const t = String(texto || '');
  const cfop = (t.match(/CFOP\s*(\d{4})/) || [])[1] || '5401';
  const por = (t.match(/por\s+([^|]+)/) || [])[1];
  return {
    cfop,
    por: por ? por.trim() : '',
    recusado: /RECUSADO/.test(t),
    doApp: /^APP\b/.test(t.trim()),
  };
}
