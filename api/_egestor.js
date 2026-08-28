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
// grupo só se troca pela tela do eGestor (a API recusa `codConfigTrib`).
//
// Grupos cadastrados: 1 = Tributação padrão (x401), 2 = REMESSA DE MERCADORIA (x917).
//
// Então:
//   5401 -> grupo padrão, emite direto.
//   5917 -> emite direto SE o grupo REMESSA já estiver aplicado na venda. O sinal
//           é o ICMS-ST: o grupo REMESSA zera (ICMS CST 40). Se ainda houver ST,
//           o grupo não foi trocado e a nota sairia 5401 — melhor barrar.
//   5113 -> não existe grupo com CFOP x113 cadastrado; enquanto não existir, a
//           nota tem que sair pela tela.
export function grupoAplicado(cfop, produtos) {
  const temST = (produtos || []).some((p) => Number(p.valorST) > 0);
  if (String(cfop) === '5917') return !temST;
  if (String(cfop) === '5401') return temST || !(produtos || []).length;
  return false;
}

export function podeEmitirPelaApi(cfop, produtos) {
  const c = String(cfop);
  if (c === '5401') return { pode: true };
  if (c === '5917') {
    if (grupoAplicado(c, produtos)) return { pode: true };
    return {
      pode: false,
      motivo:
        'Antes de autorizar, troque o grupo de tributos para "2 - REMESSA DE MERCADORIA" ' +
        'na engrenagem ao lado do produto, dentro do orçamento no eGestor. ' +
        'Do jeito que está, a nota sairia com CFOP 5401.',
    };
  }
  return {
    pode: false,
    motivo:
      `Não existe grupo de tributos com CFOP ${c} cadastrado no eGestor, ` +
      'então esta nota precisa sair pela tela (Fiscal > NF-e > Nova).',
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
