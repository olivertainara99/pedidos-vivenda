// O passo irreversível. Só a Tainara chega aqui.
//
// autorizar -> grava o CFOP, converte o orçamento em venda e, quando o CFOP é o
//              padrão 5401, emite a NF-e pela API.
// recusar   -> deixa como orçamento e marca a observação, para sair da fila.
//
// CFOP 5917 e 5113 NÃO são emitidos aqui: a API do eGestor não tem campo de CFOP
// nem de natureza da operação, então a nota sairia como 5401. Esses ficam como
// venda pronta, para emitir pela tela do eGestor.

import { eg, erro, montarObs, lerObs, podeEmitirPelaApi, cfopsAplicados, TAG_APP } from './_egestor.js';
import { exigir } from './_sessao.js';

export default async function handler(req, res) {
  if (!exigir(req, res, ['dona'])) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não suportado.' });

  try {
    const { codigo, acao } = req.body || {};
    const cod = Number(codigo);
    if (!cod) throw erro(400, 'Informe o código do pedido.');

    const venda = await eg('GET', `/vendas/${cod}`);

    if (!(venda.tags || []).includes(TAG_APP)) {
      throw erro(409, 'Esse orçamento não foi criado por este app.');
    }
    if (Number(venda.situacao) !== 10) {
      throw erro(409, 'Este pedido já saiu da fila — recarregue a página.');
    }
    if ((venda.codsNFe || []).length) {
      throw erro(409, 'Este pedido já tem nota fiscal.');
    }

    const antes = lerObs(venda.customizado && venda.customizado.xCampo1);

    if (acao === 'recusar') {
      await eg('PUT', `/vendas/${cod}`, {
        situacao: 10, // o PUT zera a situação se ela não vier junto
        campoAdicional1: montarObs({ por: antes.por, cfop: antes.cfop, nota: 'RECUSADO' }),
      });
      return res.status(200).json({ resultado: 'recusado', codigo: cod });
    }

    // O CFOP foi decidido pela regra quando o pedido nasceu — não vem do navegador.
    const escolhido = antes.cfop;

    // O CFOP sai do grupo de tributos da linha do produto. Conferimos o grupo que
    // está DE FATO aplicado antes de qualquer coisa: se não bate com o esperado,
    // a nota sairia com o CFOP errado. Barramos antes de converter em venda, para
    // o pedido continuar na fila e poder ser corrigido.
    const mapa = await cfopsAplicados();
    const veredito = podeEmitirPelaApi(escolhido, mapa[String(cod)]);
    if (!veredito.pode) {
      throw erro(409, veredito.motivo);
    }

    // A SEFAZ fora do ar e o que mais estraga esta rota: o eGestor chega a criar a
    // nota, a transmissao falha, e o pedido fica convertido em venda sem nota —
    // fora da fila e sem como voltar. Perguntamos antes; se ela nao estiver em
    // operacao, nada e convertido e o pedido continua na fila para mais tarde.
    // Nao elimina o risco (ela pode cair entre a pergunta e a emissao), mas fecha
    // quase toda a janela.
    let sefaz = null;
    try { sefaz = await eg('POST', '/nfe/status'); } catch { sefaz = null; }
    if (sefaz && Number(sefaz.status_code) !== 107) {
      throw erro(503, `A SEFAZ não está em operação agora (${sefaz.status_code} — ${sefaz.msg || 'sem detalhe'}). ` +
        'O pedido continua na fila; tente de novo daqui a pouco.');
    }

    // 1) converte o orçamento em venda
    await eg('PUT', `/vendas/${cod}`, {
      situacao: 50,
      campoAdicional1: montarObs({ por: antes.por, cfop: escolhido, nota: 'AUTORIZADO' }),
    });

    // 2) grupo conferido: emite de verdade, com o CFOP que a regra definiu
    let nota;
    try {
      nota = await eg('POST', `/vendas/${cod}/gerarNfe`, { enviar: true, contigOffline: false });
    } catch (falha) {
      // A chamada estourou. O eGestor pode ter criado a nota mesmo assim e so nao
      // ter conseguido transmitir — foi o que aconteceu em 04/11/2026. Olhamos se
      // sobrou nota na venda para dizer exatamente o que fazer, em vez de um erro
      // seco. Reemitir pelo app criaria uma segunda nota, entao nunca oferecemos.
      let criada = null;
      try {
        const ligadas = await eg('GET', `/vendas/${cod}/nfe`);
        criada = (Array.isArray(ligadas) ? ligadas : (ligadas && ligadas.itens) || [])[0] || null;
      } catch { criada = null; }
      if (criada) {
        throw erro(502,
          `A nota ${criada.numero || criada.codigo} foi criada no eGestor, mas a transmissão para a SEFAZ falhou ` +
          `(${falha.message}). Ela está no Histórico como "falta transmitir" — use o botão de lá para enviar. ` +
          'Não autorize de novo: sairia nota duplicada.');
      }
      throw falha;
    }

    const autorizada = nota && (nota.autorizada === true || Number(nota.cStat) === 100);
    return res.status(200).json({
      resultado: autorizada ? 'emitida' : 'rejeitada',
      codigo: cod,
      cfop: escolhido,
      numNota: nota && nota.numNota,
      chave: nota && nota.chNFe,
      cStat: nota && nota.cStat,
      xMotivo: nota && nota.xMotivo,
      protocolo: nota && nota.nProt,
      codNota: nota && nota.codNota,
    });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message, detalhe: e.detalhe });
  }
}
