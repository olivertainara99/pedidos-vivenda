// O passo irreversível. Só a Tainara chega aqui.
//
// autorizar -> grava o CFOP, converte o orçamento em venda e, quando o CFOP é o
//              padrão 5401, emite a NF-e pela API.
// recusar   -> deixa como orçamento e marca a observação, para sair da fila.
//
// CFOP 5917 e 5113 NÃO são emitidos aqui: a API do eGestor não tem campo de CFOP
// nem de natureza da operação, então a nota sairia como 5401. Esses ficam como
// venda pronta, para emitir pela tela do eGestor.

import { eg, erro, montarObs, lerObs, saiSozinha, TAG_APP } from './_egestor.js';
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

    // 1) converte o orçamento em venda
    await eg('PUT', `/vendas/${cod}`, {
      situacao: 50,
      campoAdicional1: montarObs({ por: antes.por, cfop: escolhido, nota: 'AUTORIZADO' }),
    });

    // 2) CFOP que a API não consegue definir: para aqui, a nota sai pela tela
    if (!saiSozinha(escolhido)) {
      return res.status(200).json({
        resultado: 'aguardando-tela',
        codigo: cod,
        cfop: escolhido,
        aviso:
          `Venda ${cod} pronta no eGestor. A nota com CFOP ${escolhido} precisa sair pela tela ` +
          `(Fiscal > NF-e > Nova), trocando a natureza da operação em "Dados gerais" — ` +
          `a API sempre emitiria como 5401.`,
      });
    }

    // 3) padrão 5401: emite de verdade
    const nota = await eg('POST', `/vendas/${cod}/gerarNfe`, { enviar: true, contigOffline: false });

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
