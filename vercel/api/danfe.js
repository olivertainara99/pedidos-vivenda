// Entrega o DANFE (PDF) de uma nota emitida, para a Tainara mandar ao Jean.
//
// O eGestor só devolve o arquivo com o token, e o token não sai do servidor —
// então o app busca e repassa. Quem pedir precisa estar logado.

import { egBinario, erro } from './_egestor.js';
import { exigir } from './_sessao.js';

export default async function handler(req, res) {
  if (!exigir(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ erro: 'Método não suportado.' });

  try {
    const codigo = Number(req.query.codigo);
    if (!codigo) throw erro(400, 'Informe o código da nota.');

    // O número só serve para nomear o arquivo. Não perguntamos ao eGestor
    // porque GET /nfe/{cod} devolve o XML inteiro junto, e cada chamada conta
    // no limite de 60/min — que fica apertado quando ela emite a fila toda.
    // Se a nota não estiver autorizada, o próprio /danfe recusa.
    const numero = String(req.query.numero || '').replace(/\D/g, '');

    const pdf = await egBinario(`/nfe/${codigo}/danfe`);
    const nome = `NFe-${numero || codigo}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nome}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).send(pdf);
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
