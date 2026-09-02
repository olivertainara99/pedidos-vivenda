// Junta os DANFEs de várias notas num PDF só, para mandar de uma vez ao Jean.
//
// Sozinho, o botão de cada nota vira uma conversa de dez arquivos no WhatsApp.
// Aqui ela marca as notas do dia e recebe um arquivo único, na ordem do número.

import pdfLib from 'pdf-lib';
import { egBinario, erro } from './_egestor.js';
import { exigir } from './_sessao.js';

const { PDFDocument } = pdfLib;

// Teto de segurança: 30 DANFEs dão ~800 KB, bem abaixo do limite de resposta
// da Vercel, e 30 chamadas cabem no limite de 60/min do eGestor.
const MAX = 30;

// Baixa em blocos: tudo de uma vez atropela o eGestor, um a um estoura o tempo
// da função.
const POR_VEZ = 6;

export const config = { maxDuration: 60 };

async function baixarTodos(notas) {
  const pdfs = [];
  for (let i = 0; i < notas.length; i += POR_VEZ) {
    const bloco = notas.slice(i, i + POR_VEZ);
    const vindos = await Promise.all(
      bloco.map(async (n) => ({ n, bytes: await egBinario(`/nfe/${n.codigo}/danfe`) }))
    );
    pdfs.push(...vindos);
  }
  return pdfs;
}

export default async function handler(req, res) {
  if (!exigir(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não suportado.' });

  try {
    const corpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const pedidas = Array.isArray(corpo.notas) ? corpo.notas : [];

    // ordena pelo número da NF-e para o PDF sair na ordem em que ela emitiu
    const notas = pedidas
      .map((n) => ({ codigo: Number(n.codigo), numero: Number(n.numero) || 0 }))
      .filter((n) => n.codigo)
      .sort((a, b) => a.numero - b.numero || a.codigo - b.codigo);

    if (!notas.length) throw erro(400, 'Marque pelo menos uma nota.');
    if (notas.length > MAX) throw erro(400, `Dá para juntar até ${MAX} notas de uma vez. Marque menos e mande em duas levas.`);

    const baixados = await baixarTodos(notas);

    const juntado = await PDFDocument.create();
    for (const { bytes } of baixados) {
      const doc = await PDFDocument.load(bytes);
      const paginas = await juntado.copyPages(doc, doc.getPageIndices());
      paginas.forEach((p) => juntado.addPage(p));
    }
    juntado.setTitle(`Notas ${notas[0].numero || notas[0].codigo} a ${notas[notas.length - 1].numero || notas[notas.length - 1].codigo}`);

    const pdf = Buffer.from(await juntado.save());
    const nome = nomeDoArquivo(notas);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nome}"`);
    return res.status(200).send(pdf);
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}

function nomeDoArquivo(notas) {
  const num = (n) => n.numero || n.codigo;
  if (notas.length === 1) return `NFe-${num(notas[0])}.pdf`;
  return `NFe-${num(notas[0])}-a-${num(notas[notas.length - 1])}.pdf`;
}
