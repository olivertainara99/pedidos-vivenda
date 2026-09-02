# Contexto: Emissão de notas fiscais no eGestor

## Objetivo da Tainara
Ela manda por chat o nome do cliente e a quantidade de cada produto, e o Claude emite a nota fiscal (NF-e) no eGestor. Fluxo validado de ponta a ponta pelo navegador (primeira nota real: 27/08/2026). A partir de agora o caminho **preferencial é a API** (mais rápido e menos sujeito a erro de clique); o navegador fica como plano B.

## Acesso
- Sistema: eGestor (https://v4.egestor.com.br/inicio/)
- Subdomínio: rtkalume · Usuário: tainara
- Empresa emitente: VIVENDA DOS SUCOS (R. T. KALUME), CNPJ 23388480000105, São Francisco do Pará/PA. Plano profissional.
- Senha: fornecida pela Tainara no chat quando necessário, NÃO é salva aqui.
- Ambiente das notas: **Produção** (documento fiscal real, transmitido à SEFAZ).

---

# Caminho A — API (preferencial)

## Por que é melhor
Emitir pela tela leva ~30 interações de navegador (abrir menu, buscar cliente, abrir modal de produto 9x, rolar formulário, salvar). Pela API são **4 chamadas HTTP**, sem bug de autocomplete, sem risco de clicar no cliente errado e sem depender de o painel do navegador estar renderizando.

## Setup — FEITO em 27/08/2026
- Aplicativo de API criado no eGestor: **cód. 1, "Acesso eGestor Padrão"**, usuário **Tainara** (as permissões dela são as que a API usa), e-mail de contato olivertainara99@gmail.com.
- `personal_token` salvo em `token.local` (não versionado, está no `.gitignore`). Subdomínio no token: `rtkalume`.
- Conexão validada: `bash egestor.sh empresa` retorna R. T. KALUME / VIVENDA DOS SUCOS, CNPJ 23388480000105.
- Catálogo baixado em `cache/produtos.json` (20 produtos).

⚠️ Se alguém editar esse aplicativo na tela do eGestor, **um token novo é gerado e o atual para de funcionar**. Nesse caso: Configurações > API > abrir o cód. 1 > copiar o "Token de Acesso" > substituir o conteúdo de `token.local` > apagar `.access_token`.

## Endpoints usados
Base: `https://api.egestor.com.br/api/v1` · Auth: OAuth2, `POST /api/oauth/access_token` com `grant_type=personal` → `access_token` válido por **900s**. Limite: **60 req/min**. Listagens: 50 registros por página.

| Passo | Chamada |
|---|---|
| 1. Resolver cliente | `GET /contatos?filtro=<nome>` → `codigo` |
| 2. Resolver produtos | `GET /produtos?filtro=<nome>` → `codigo`, `precoVenda` |
| 3. Criar a venda | `POST /vendas` (situacao 50 = Venda; 10 = Orçamento) → `codigo` da venda |
| 4. Gerar a NF-e | `POST /vendas/{codVenda}/gerarNfe` com `{"enviar":true}` → `numNota`, `chNFe`, `cStat`, `xMotivo` |

Retorno de sucesso do passo 4: `"cStat": 100`, `"xMotivo": "Autorizado o uso da NF-e"`, `"autorizada": true`, `"nProt"`, `"ambiente": "1"` (produção).

Também existe `POST /vendas/{cod}/gerarNfce` (NFC-e / cupom) e `GET /vendas/{cod}/gerarNfse` (serviço), caso um dia precise.

## Comandos do helper (`egestor.sh`)

```bash
bash egestor.sh clientes "LIDER"
```
```bash
bash egestor.sh produtos "SUCO DE CANA"
```
```bash
bash egestor.sh venda pedido.json
```
```bash
bash egestor.sh nfe 123
```
```bash
bash egestor.sh nfe 123 --enviar
```

- `clientes <termo>` — busca contato e mostra cidade/bairro/endereço pra conferência.
- `produtos <termo>` — busca produto com código e preço de venda.
- `venda <arquivo.json>` — cria a venda, retorna o código dela.
- `nfe <codVenda>` — gera a nota **sem enviar** (situação "Criada"). Seguro, nada vai pra SEFAZ.
- `nfe <codVenda> --enviar` — gera **e transmite** à SEFAZ. Irreversível.
- `nfe-status <codNota>` · `danfe <codNota> nota.pdf` · `xml <codNota> nota.xml`.
- `catalogo` — baixa o catálogo inteiro pro cache.
- `get <caminho>` / `post <caminho> <arquivo.json>` — acesso cru a qualquer endpoint.

`pedido.json` segue o `modelo-venda.json`:

```json
{
  "codContato": 5,
  "codVendedor": 3,
  "dtVenda": "2026-08-27",
  "situacao": 50,
  "tags": ["NF_VIA_API"],
  "produtos": [
    { "codProduto": 1, "quant": 20, "preco": 3.45, "vDesc": 0 }
  ]
}
```

**`codVendedor` é obrigatório nesta conta** (a API devolve 400 sem ele). Vendedores: **3 = Tainara**, 1 = Rubens. Ambos com comissão 0, então não muda valor.

Campos opcionais úteis: `valorFrete`, `valorDesc`, `financeiros[]` (parcelas), `customizado.xCampo1` (observações gerais).

**O `valorTotal` que a venda devolve já inclui o ICMS-ST** e por isso é maior que a soma dos produtos. A conta é `vProd × 20% (MVA) × 19% (ICMS-ST) = vProd × 3,8%`. Ex.: 179,75 → ST 6,82 → total 186,57. Não é erro; a NF 13479 se comporta igual (566,00 → 21,50 → 587,50).

---

# App de pedidos do Jean

**URL:** https://claude.ai/code/artifact/0d380c52-85ef-4493-95a5-bb34ce31c845
**Fonte:** `app/pedidos.html` (republicar o mesmo arquivo mantém a URL)

**Logo.** A marca da Vivenda dos Sucos vem embutida como data URI WebP (198×118, com transparência, ~8KB) na constante `LOGO` do script. O original está no próprio eGestor, em `img.logomarca` do formulário da NF-e — o arquivo servido em `/imgs/logo.png` só responde com a sessão logada, então foi extraído pelo navegador via canvas. Cópias locais: `app/logo.txt` (data URI) e `app/logo.webp` (binário).

Ela aparece sobre uma **chapa branca arredondada** (`.chapa`) no cabeçalho e na tela de escolha de papel. Isso é de propósito: a logo tem letras verde-escuras e sumiria no tema escuro. Sobre a chapa ela mantém as cores próprias nos dois temas.

Ao abrir pela primeira vez, o aparelho escolhe um papel (fica salvo em `localStorage`, com um "trocar" no topo):

**Papel "vou anotar pedidos" (Jean).** Escolhe o cliente pela busca (os 60 contatos reais do eGestor, com bairro e cidade), digita as quantidades (os 20 produtos reais, com preço), monta a fila e toca em **"Mandar para autorização"**. Ele não vê botão de autorizar.

**Papel "vou autorizar emissão" (Tainara).** Vê o bloco "Aguardando sua autorização" com cada pedido anotado, e marca **Autorizar**, **Recusar** ou **Excluir** (ou "Autorizar todos"). As marcações ficam locais até tocar em **"Salvar autorização"**, que publica tudo de uma vez.

**Recusar × Excluir.** Recusar deixa o pedido no histórico com status `recusado` — fica o registro de que ele existiu e não virou nota. Excluir apaga de vez. Por ser irreversível, o Excluir não some na hora: o pedido fica riscado e vai para a área **"Vai apagar de vez"** no fim do bloco, listando cliente, valor e quem lançou, e só some ao salvar. No código, excluir só age sobre pedido com status `anotado` — pedido já emitido corresponde a documento fiscal e o registro dele não é apagável pelo app.

Só então o Claude emite — e **apenas os pedidos com status `autorizado`**.

- **Cliente e produto saem do cadastro**, com `codContato` e `codProduto` já resolvidos. Acaba o risco de "Castanheira vs Castanhal" e de "caldo vs suco" — buscar "lider castanheira" traz uma opção só.
- A fila do Jean fica em `localStorage` enquanto ele monta, então não se perde se fechar o navegador. Só vira publicação quando ele manda.
- Cada pedido carrega quem lançou e a hora.
- Ciclo do status: `fila` (local do Jean) → `anotado` (esperando a Tainara) → `autorizado` ou `recusado` → `emitida` (com número da NF) ou `erro`.

**O papel é conveniência, não tranca.** Quem tiver acesso de edição pode trocar de papel na própria tela. A garantia real continua sendo a de sempre: **o Claude só emite o que está marcado como `autorizado`, e confirma com a Tainara no chat antes de transmitir.**

**Para o Jean poder mandar, ele precisa de acesso de EDIÇÃO ao artifact** (menu de compartilhamento da página). Com acesso só de leitura, a página detecta e mostra o botão **Copiar**, que gera o texto do pedido já no formato certo pra mandar por WhatsApp — funciona, só não é automático.

---

# App web na Vercel (o caminho principal a partir de 28/08/2026)

- **No ar:** https://pedidos-vivenda.vercel.app
- **Código:** https://github.com/olivertainara99/pedidos-vivenda (privado)
- **Fonte local:** `vercel/` — push no `main` republica sozinho
- **Diagnóstico:** `/api/saude` — sem login mostra quais variáveis existem; logado, testa a conexão com o eGestor

Substitui o artifact para o uso do dia a dia. A diferença que importa: **o app emite a nota sozinho**, sem depender de eu estar na conversa.

## Sem banco de dados: o eGestor guarda tudo
O pedido do Jean vira um **Orçamento** (`situacao: 10`) com a tag `APP_PEDIDOS`, o que o separa dos 325 orçamentos antigos da conta. Ao autorizar, `PUT` com `situacao: 50` converte em Venda e então `gerarNfe` emite.

O CFOP escolhido e quem lançou ficam em `customizado.xCampo1` ("Observações gerais"), no formato `APP | por Jean | CFOP 5401`. É o único campo que a API deixa alterar depois que a venda existe.

## As telas do app
| aba | quem vê | o que faz |
|---|---|---|
| **Lançar pedido** | Jean e Tainara | escolhe cliente, quantidades, monta a fila e manda |

A fila fica no **aparelho** (`localStorage`, chave `vds_fila_<papel>`), não no servidor. Isso é de propósito: o Jean monta ao longo do dia, fecha o navegador quantas vezes quiser, e só manda no fim. Consequência a lembrar: **a fila não atravessa aparelhos** — o que ele lançar no celular não aparece no computador. Ao reabrir, os preços são reconferidos contra o catálogo, caso o pedido tenha virado o dia.
| **Autorizar (n)** | só Tainara | confere, autoriza/recusa/exclui — é onde a nota é emitida |
| **Anexar PDF** | Jean e Tainara | lê o PDF que a loja manda e põe os pedidos na fila |
| **Histórico** | Jean e Tainara | últimos 30 dias, agrupado por data, com o desfecho de cada pedido |

## Leitura do PDF de pedido (`api/importar.js`)
Dois formatos, distinguidos pelo título — conferido que não colidem:

| rede | título | pedidos por arquivo | particularidades |
|---|---|---|---|
| **Mateus** | `PEDIDO DE COMPRAS` (plural) | **vários** | itens com código próprio + EAN de 13 dígitos |
| **LIDER** | `PEDIDO DE COMPRA` (singular) | **um** | preço com 3 casas (`6,550`); colunas do meio (desconto, despesas, IPI, frete) podem vir vazias, então o **total é o último número da linha**; a "Referência" de 6 dígitos é o nosso código próprio |
| **FORMOSA** | relatório de produtos vendidos | **um por filial** | é a base das notas **5113** — importar logada como Tainara. Ver detalhes abaixo |

### O relatório da FORMOSA
- O PDF usa **`x-none` como separador de célula**, o que resolve a ambiguidade dos números (o texto vem com os caracteres espaçados: `1 1 , 0 0 0 0`).
- Linha vendida tem **5 células** (nome, preço, quantidade, total, código); linha sem venda tem 4 — falta a quantidade — e é ignorada. Filial que não vendeu nada não vira pedido.
- ⚠️ **Pegadinha:** a coluna do cabeçalho se chama `TOTAL` e a linha que fecha a tabela é `TOTAL:`. Sem exigir os dois-pontos, sai o dobro de tabelas.
- ⚠️ **Os rótulos das filiais são desenhados DEPOIS das tabelas, em blocos** — não colados a elas. O pareamento é **pela ordem** e não dá para provar. Por isso a tela mostra um **seletor de loja** em cada pedido e pede conferência. Emitir para a loja errada é o erro mais caro aqui.

### Mapas de código, guardados no eGestor (não no código)
A FORMOSA usa códigos próprios diferentes dos do Mateus — `981779-4` em vez de `281893`. Como `codigoProprio` já está ocupado pelo código do Mateus:

| o quê | onde mora | formato |
|---|---|---|
| código do produto na FORMOSA | `anotacoesInternas` do produto | `FORMOSA:981779-4` |
| rótulo da filial da FORMOSA | `obs` do contato | `FORMOSA:DUQUE` |

Assim a Tainara corrige sozinha no eGestor se a FORMOSA mudar algo, sem mexer no app. Os 11 produtos foram mapeados com o **preço conferido um a um** contra o relatório.

Validados com arquivos reais: Mateus com 5 pedidos, LIDER com 1 (LJ 37 Capanema, 223,80 / 48 unidades).

No documento da LIDER, `TOTAL PEDIDO` já inclui a substituição tributária (223,80 + 8,52 = 232,32). O app usa o **`Total do Pedido`**, que é o valor dos produtos — o ST sai do cadastro na hora da nota, não do que a loja escreveu.

Para ensinar uma rede nova: escrever uma função `ler...` que devolva `{loja, cnpj, numero, entrega, itens[], qtdDocumento, totalDocumento}` e encadeá-la no `||` do handler.

**Sem dependência nenhuma:** os fluxos de texto do PDF vêm comprimidos com Flate, e o `zlib` do próprio Node descomprime. O texto desenhado fica entre parênteses nos fluxos.

**Como cada pedido é delimitado:** vai do cabeçalho até o `Vlr. TOTAL` dele. Isso se delimita sozinho, sem depender do nome da rede.

⚠️ **Pegadinha que custou uma tentativa:** o cabeçalho de um pedido vem depois do `Vlr. TOTAL` do anterior e carrega junto os *DADOS DA ENTREGA do anterior* — com o CNPJ da loja anterior. Por isso valem sempre o **último** CNPJ, o último nome e a última data antes do `PEDIDO DE COMPRAS`. Pegar o primeiro dá a loja errada.

**Identificação por código, nunca por nome.** O pedido chama "CALDO CANA DAMOENDA 1L", o cadastro chama "SUCO DE CANA DE ACUCAR 1 LITRO" — casar por nome cairia na armadilha caldo × suco. Casa por **CNPJ** (`cpfcnpj` do contato) e por **código próprio** (`codigoProprio`) ou **EAN** (`refEanGtin`). O que não casar é recusado com o motivo.

**Confere as contas do documento** antes de aceitar: qtd × preço de cada linha, soma dos itens contra o total impresso, soma das quantidades. Não fechando, o pedido vem marcado como não aproveitável.

**Nada entra na fila sem confirmação humana** — o Jean vê o que foi lido e decide.

⚠️ **Pendência:** os três sabores de laranja estão **sem código próprio** no cadastro, e os de limão estão com "04"/"05"/"06", que parecem provisórios. Pedido que traga esses itens não vai casar. Confirmar os códigos com Mateus e LIDER e preencher no eGestor.

**Fotos (JPEG) não são lidas.** O servidor não enxerga imagem — precisaria de um serviço de visão externo, com chave e custo. Pedido que chega por foto continua sendo lançado à mão, ou mandado para o Claude no chat.

O histórico mostra, por pedido: cliente, itens, total, CFOP, hora e o estado — *aguardando*, *autorizada*, *emitida* (com o número da NF-e), *cancelada* ou *rascunho*. O dia mais recente vem aberto, os anteriores recolhidos com contagem e total no cabeçalho.

Custa **duas chamadas** para os 30 dias inteiros, não importa quantos pedidos: o relatório `detalhesProdutosVendidos` traz itens/CFOP/situação de todas as vendas, e a lista de NF-e converte o código interno da nota no número dela. O `por` (quem lançou) não aparece ali — está no `xCampo1` de cada venda, e buscá-lo custaria uma chamada por pedido.

## Entrada no app
A tela de login pergunta **quem vai usar** — Jean (anota pedidos) ou Tainara (autoriza e emite) — e só então libera o campo de senha, já dizendo de quem é a senha esperada. No servidor a senha é conferida contra o papel informado. A escolha fica lembrada no aparelho.

## Variáveis na Vercel
`EGESTOR_PERSONAL_TOKEN`, `SENHA_JEAN`, `SENHA_TAINARA`, `SESSION_SECRET`.
O token vive **só no servidor** — nunca chega ao navegador. Sessão em cookie HttpOnly assinado com HMAC. Os preços vêm sempre do cadastro no momento do lançamento; o navegador só manda código de produto e quantidade.

Cópia local das variáveis prontas para colar: `variaveis-vercel.txt` (fora do repositório, contém o token — não compartilhar).

## Armadilhas da API descobertas montando isso
- `PUT /vendas/{cod}` **zera a situação** se `situacao` não for enviado junto. Sempre mandar.
- `situacaoOS` só aceita "Em espera", "Em execução", "Finalizada", "Entregue" — não serve para estado livre.
- O parâmetro `filtro` da listagem de vendas **busca por tag**, o que permite isolar os pedidos do app.

---

# CFOP — as três naturezas de operação

Conferido nos XMLs de notas reais da conta (não é suposição):

| CFOP | Natureza da operação | Tributação | Quem usa |
|---|---|---|---|
| **5401** | Venda de produção do estabelecimento quando o produto esteja sujeito a ST | ICMS CST 10 com ST (MVA 20% × 19% = 3,8%), PIS/COFINS CST 01, IPI CST 51 | Padrão de tudo |
| **5917** | Remessa de mercadoria em consignação mercantil ou industrial | **Nada.** ICMS CST 40 (isento), PIS/COFINS CST 07 (não tributados). `vNF = vProd` | Só nas notas do FORMOSA que o Jean manda |
| **5113** | Venda de produção do estabelecimento remetida anteriormente | Igual à 5401 — ICMS CST 10 com ST, PIS/COFINS CST 01 | Só a Tainara pede. Fecha a consignação |

Referências verificadas: NF-e 13109 (5917, vProd 553,00 = vNF 553,00, zero imposto) e NF-e 13093 (5113, vProd 414,30 + ST 15,75 = vNF 430,05).

A lógica de negócio: o Jean remete a mercadoria em consignação (5917, sem imposto) e depois a Tainara fatura a venda do que já foi remetido (5113, com imposto).

## Regra automática de CFOP (app da Vercel, desde 28/08/2026)
Não há mais escolha manual. O **servidor decide quando o pedido nasce**, a partir do cliente e de quem lançou:

| cliente | quem lançou | CFOP | emite sozinho? |
|---|---|---|---|
| FORMOSA | Jean | **5917** | não — nota pela tela |
| FORMOSA | Tainara | **5113** | não — nota pela tela |
| qualquer outro | qualquer um | **5401** | **sim** |

A detecção é por `/FORMOSA/i` no nome do contato, então loja nova da rede entra na regra sozinha. A regra vive em `cfopPara()` no `api/_egestor.js` e o endpoint de autorização **ignora qualquer CFOP vindo do navegador** — usa o que ficou gravado no pedido.

Consequência: **nenhuma nota da FORMOSA sai automática.** Elas viram venda pronta e a nota é emitida pela tela. Isso não é limitação da regra, e sim da API, que não define natureza da operação.

Como a Tainara também lança pedidos (para o 5113), a tela dela tem duas abas: **Autorizar** e **Lançar pedido**.

## ✅ CORREÇÃO: a API emite 5917 sim — o CFOP vem do grupo de tributos
Descoberto em 28/08/2026, por observação da Tainara. **O CFOP não vem de configuração global: vem do grupo de tributos (`configTrib`) da linha do produto dentro da venda.**

Grupos cadastrados na conta:

| cód | descrição | CFOP | tributação |
|---|---|---|---|
| 1 | Tributação padrão (é o default) | x401 | ICMS 10 a 19%, ST 19%, MVA 20%, IPI 51, PIS/COFINS 01 |
| 2 | REMESSA DE MERCADORIA | x917 | ICMS 40 (isento), PIS/COFINS 07, sem IPI |
| 3 | VENDA REMETIDA ANTERIORMENTE | x113 | igual ao grupo 1 |
| 4 | MEL DE CANA | x101 | ICMS 00 a 19% **sem ST**, PIS/COFINS 01, **IPI 50 a 3,25%** |

## Tributação por produto (tabela do contador, 29/08/2026)
| produto | CFOP | CST ICMS | ST | MVA | ICMS | IPI | grupo |
|---|---|---|---|---|---|---|---|
| Suco de cana (todos) | 5401 | 010 | sim | 20% | 19% | 0% | **1** |
| Biscoito com mel | 5401 | 010 | sim | 20% | 19% | 0% | **1** |
| Mel de cana | **5101** | 000 | não | — | 19% | **3,25%** | **4** |

Consequência para o app: **uma nota comum pode ter CFOPs diferentes por item** (suco e biscoito em 5401, mel em 5101), o que é normal. Por isso o app **não força grupo em pedido comum** — cada produto já está no grupo certo. Só a FORMOSA força, porque ali a nota inteira muda de natureza, e depois cada produto volta ao grupo dele (`devolverGrupos`, que anota o grupo original de cada um em vez de assumir o 1).

**Verificado na prática:** criei o orçamento 3711 (FORMOSA DUQUE), a Tainara trocou o grupo do item para REMESSA na tela, e a NF-e gerada **pela API** saiu com CFOP 5917, natOp "Remessa de mercadoria em consignação mercantil ou industrial", ICMS CST 40, PIS/COFINS CST 07, vProd 34,50 = vNF 34,50. Teste apagado depois.

**O que a API não faz:** aceitar `codConfigTrib` no `POST /vendas` — recusa com `errFields: ["codConfigTrib"]`.

## A venda fotografa o grupo — e é isso que automatiza tudo
Verificado em 28/08/2026: pus o produto 1 no grupo 2, criei um orçamento (saiu `x917`), e **devolvi o produto ao grupo 1**. A venda **permaneceu** `codGrupTrib: 2`, `cfop: x917`, R$ 34,50 sem ST. Ou seja, **a linha da venda guarda o grupo do instante da criação** e não acompanha mudanças posteriores no produto.

Com isso o app faz, ao criar um pedido:
1. lê o grupo atual de todos os produtos (**1 chamada**)
2. põe no grupo exigido pelo CFOP só os produtos daquele pedido que ainda não estão nele
3. cria a venda — que fotografa o grupo
4. devolve ao grupo padrão os que mexeu

Pedido comum (5401) não gera nenhum PUT, porque os produtos já estão no grupo 1. Pedido da FORMOSA gera 2 PUTs por item.

O campo é `codigoGrupoTributos` no `PUT /produtos/{cod}` (o mesmo dado aparece como `codConfigTrib` nos filtros de listagem — a API usa dois nomes).

**Nenhum passo manual, nenhuma senha no servidor, só API documentada.** Descartadas no caminho: duplicar produtos (fragmentaria o estoque, `controlarEstoque: true`) e usar endpoint interno do eGestor (exigiria a senha na Vercel e login programático, que já gerou captcha).

**Risco residual:** se dois pedidos forem criados no mesmo instante, um pode fotografar o grupo do outro. A conferência de CFOP na autorização barra antes de transmitir, então não sai nota errada — o pedido só volta para a fila com o aviso.

**Grupo 3 criado em 28/08/2026:** `3 - VENDA REMETIDA ANTERIORMENTE`, CFOP **x113**, com os tributos idênticos aos do grupo 1. Com ele, **os três CFOPs saem pela API**.

## Como saber qual grupo está aplicado numa venda
`GET /vendas/{cod}` **não** expõe o grupo — a linha do produto só traz os valores calculados. O único lugar da API que mostra é o relatório:

```
POST /relatorios/detalhesProdutosVendidos
{"tipoData":"dtCad","de":"...","ate":"...","tags":"APP_PEDIDOS",
 "mostrarCFOP":true,"mostrarGrupoTrib":true,"mostrarAbertas":true}
```

Cada linha volta com `"cfop":"x401"` e `"codGrupTrib":"1"`. O `mostrarAbertas` inclui orçamentos, e o filtro por `tags` isola os do app — **uma chamada cobre a fila inteira**.

O app compara o CFOP aplicado com o esperado pela regra e:
- bate → **emite sozinho**
- não bate → **barra antes de converter em venda**, dizendo qual grupo escolher, e o pedido continua na fila para ser corrigido

(Antes eu usava o ICMS-ST como sinal, mas isso só distinguia o 5917 — o grupo 3 tributa igual ao grupo 1. O relatório resolveu de vez.)

## ⚠️ Histórico: por que se achava que a API não definia CFOP
`POST /vendas` e `POST /vendas/{cod}/gerarNfe` não têm campo de CFOP nem de natureza da operação — CFOP só aparece na API em relatórios e em leitura de nota. A nota emitida pela API sempre sai com o **padrão da conta, 5401**.

Consequência prática:
- Pedido marcado como **5401** → emitir pela API, com `emitir.sh`.
- Pedido marcado como **5917 ou 5113** → emitir **pela tela**: Fiscal > NF-e > Nova, e em "Dados gerais" trocar a natureza da operação antes de preencher o resto.

Se um dia for preciso automatizar isso, o único caminho pela API seria montar o XML inteiro e usar `POST /nfe/salvar` — bem mais trabalhoso e sujeito a erro que a tela.

---

## Emitir a fila
Só os pedidos com `status: "autorizado"`. Para cada um, uma linha:

```bash
bash emitir.sh 5 1:20 2:15 3:5
```

`emitir.sh <codContato> <codProduto:qtd>...` busca os preços frescos do cadastro, cria a venda e transmite. Com `--rascunho` antes do codContato, gera a nota sem enviar à SEFAZ.

Depois de emitir tudo, atualizar os status no app republicando `app/pedidos.html` com o JSON de estado ajustado (`status`, `nf`, `chave` por pedido).

---

## Ordem de operação do Claude
1. Resolver cliente e produtos contra o cadastro real (passos 1 e 2).
2. Montar `pedido.json` e **mostrar o resumo completo no chat** (cliente + cada produto + quantidade + preço unitário + total), explicitando qualquer interpretação feita (ex.: "caldo" → linha SUCO DE CANA).
3. Só depois da confirmação explícita da Tainara: `venda` e em seguida `nfe <cod> --enviar`.
4. Reportar `numNota`, `chNFe` e `xMotivo` no chat.

## Tributação via API — VALIDADA em 27/08/2026
Comparei o XML da nota gerada pela API (cód. 3849, venda 3709) com o da NF-e 13479 emitida pela tela. **Bate em todos os campos fiscais:**

| campo | valor (idêntico nas duas) |
|---|---|
| CFOP / natOp | 5401 / "Venda de produção do estabelecimento..." |
| CST ICMS | 10 (tributada com ST) |
| pICMS / pMVAST / pICMSST | 19,00% / 20,00% / 19,00% |
| CST IPI | 51 (isento) |
| CST PIS/COFINS | 01 — 1,65% / 7,60% |
| CRT | 3 (Regime Normal) |
| indFinal / indIEDest | 0 / 1 (contribuinte) |
| tPag / modFrete | 90 (sem pagamento) / 0 |
| tpAmb | 1 (Produção) |

Ou seja, a API herda exatamente o mesmo tratamento fiscal da tela. **Não precisa mais repetir a conferência a cada nota** — dá pra ir direto de `venda` para `nfe --enviar`.

Se algum dia mudar o grupo de tributos de um produto ou a natureza padrão da conta, refazer essa conferência com `nfe <codVenda>` sem `--enviar` (a nota fica na situação 5 "Criada", nada vai pra SEFAZ) e `nfe-status <codNota>`, que devolve o XML inteiro.

## ⚠️ Não gerar rascunho se a intenção é emitir
**A API não tem endpoint para transmitir uma nota já criada.** O único jeito de transmitir pela API é no mesmo passo em que a nota é gerada (`gerarNfe` com `"enviar": true`). Se você gerar o rascunho primeiro com `nfe <codVenda>`, a única forma de mandar aquela nota específica é pela tela (Fiscal > NF-e > clicar na nota > "Salvar e enviar") — foi o que aconteceu com a 13489.

Como a tributação já está validada, **o fluxo normal agora é uma chamada só**: `bash egestor.sh nfe <codVenda> --enviar`.

(Nota criada e não enviada fica com número **0** — o número fiscal só é atribuído na transmissão. Então um rascunho abandonado não gera lacuna de numeração, mas suja a listagem.)

## Erros comuns da API
| Código | O que é |
|---|---|
| 400 | Campo inválido ou inexistente no payload |
| 401 | `access_token` inválido/expirado (o helper renova sozinho) |
| 422 | Valor fora do escopo do campo |
| 429 | Passou de 60 req/min — esperar alguns segundos |
| `cStat` ≠ 100 | Rejeição da SEFAZ; ler `xMotivo` (ex.: "IE do destinatário inválida") |

## Cancelar uma NF-e — só pela tela
**A API não tem endpoint de cancelamento de NF-e** (só listar, detalhar, XML e DANFE). O caminho é:

1. Fiscal > aba NF-e > marcar o **checkbox** da linha da nota.
2. Clicar no botão **⊘ "Cancelar NFe"** na barra de ferramentas (`#nfe_cancelarNota`, o ícone de proibido, entre o "?" e a impressora). Não fica no menu da linha — a linha só tem "Imprimir".
3. Preencher a **justificativa (mínimo 15 caracteres)** e clicar em "Continuar".
4. Sucesso = **cStat 135, "Evento registrado e vinculado a NF-e"**. A situação da nota vira **90** (confirmável por `nfe-status`).

Prazo legal: o cancelamento só é aceito pela SEFAZ dentro da janela permitida (em regra 24h da autorização). Depois disso, o caminho é carta de correção ou nota de devolução.

Documentação: https://egestor.docs.apiary.io/ · https://github.com/eGestor/documentacao-api

---

# Caminho B — Navegador (plano B, validado)

Usar quando a API estiver indisponível, o token não tiver sido gerado, ou algum campo não for coberto pela API.

1. Menu lateral (ícone hambúrguer em telas estreitas) > "NFe / Fiscal" > aba "NF-e" > botão verde "Nova".
2. "Dados gerais": deixar defaults (natureza "5401 - Venda de produção...", tipo Saída).
3. "Dados do destinatário": campo "Razão/Nome destinatário" com autocomplete. Se a lista não filtrar na primeira tentativa, apagar e redigitar (bug de UI comum). Conferir CUIDADOSAMENTE a opção — matriz e filial aparecem juntas (ex.: "LIDER COMERCIO E INDUSTRIA LTDA" vs "... - LJ 10 CASTANHAL"). Depois de selecionar, checar o card de Cidade/Bairro/Endereço embaixo.
4. "Lista de produtos/serviços" > "Adicionar produto" (um por vez): "Nome do Produto" (mesmo bug de filtro), "Quantidade" (default 1,0000 — trocar e clicar fora pra recalcular o total), "Preço unit." vem do cadastro. Rolar até o fim do modal (a seção de impostos pode ficar como veio) e "Salvar".
5. Repetir por item.
6. Mostrar o resumo completo no chat e aguardar confirmação.
7. Rolar até o fim do formulário e clicar em **"Salvar e enviar"** (não "Apenas salvar", que só grava rascunho).

---

# Catálogo de produtos (via API, 27/08/2026)

Linha **SUCO DE CANA DE ACUCAR** — é essa que bate com pedidos de "caldo de cana [tamanho] [sabor]", mesmo a Tainara chamando de "caldo":

| cód | produto | preço |
|---|---|---|
| 1 | SUCO DE CANA DE ACUCAR 330ML | 3,45 |
| 2 | SUCO DE CANA DE ACUCAR 500ML | 5,20 |
| 3 | SUCO DE CANA DE ACUCAR 1 LITRO | 6,55 |
| 4 | SUCO DE CANA DE ACUCAR COM LIMÃO 330ML | 4,80 |
| 5 | SUCO DE CANA DE ACUCAR COM LIMÃO 500ML | 6,90 |
| 6 | SUCO DE CANA DE ACUCAR COM LIMÃO 1 LITRO | 9,00 |
| 18 | SUCO DE CANA DE ACUCAR COM LARANJA 330ML | 4,80 |
| 19 | SUCO DE CANA DE ACUCAR COM LARANJA 500ML | 6,90 |
| 20 | SUCO DE CANA DE ACUCAR COM LARANJA 1 LITRO | 9,00 |

Linha **CALDO DE CANA** (nome literal no catálogo) — separada, sem sabores, preços bem mais altos. **Não confundir com a de cima.**

| cód | produto | preço |
|---|---|---|
| 29 | CALDO DE CANA COPO 300ML | 6,99 |
| 28 | CALDO DE CANA COPO 500ML | 10,99 |
| 26 | CALDO DE CANA GARRAFA 500ML | 12,99 |
| 27 | CALDO DE CANA GARRAFA DE 1 LITRO | 18,99 |

Outros: 13 MEL DE CANA DA MOENDA 360G (8,50) · 21 BISCOITO COM MEL DE CANA E ESPECIARIAS 70g (5,90) · 25 CANA DE ACUCAR IN NATURA 35cm (3,99) · 23 BAGAÇO DE CANA DE AÇUCAR (0) · 16, 17, 24 são equipamentos (freezer/vitrine/cervejeira).

Todos os sucos: NCM 20098990, unidade UN.

# Clientes LIDER (29 lojas, códigos via API)
O grupo LIDER tem 29 cadastros. **Sempre confirmar a loja pelo bairro/cidade antes de emitir.** As mais prováveis:

| cód | loja | bairro / cidade |
|---|---|---|
| 5 | LIDER COMERCIO E INDUSTRIA LTDA (fantasia LIDER CASTANHEIRA) | CASTANHEIRA / Belém |
| 27 | ...LJ 10 CASTANHAL | CENTRO / **Castanhal** |
| 28 | ...LJ 50 ESTRELA | ESTRELA / **Castanhal** |
| 1 | ...LJ 01 CONDOR | CONDOR / Belém |
| 10 | ...LJ 12 BR | COQUEIRO / Ananindeua |

Atenção: o cód. 5 é o que aparece só como "LIDER COMERCIO E INDUSTRIA LTDA" (sem sufixo de loja) e é o da **Castanheira, Belém** — foi o da NF-e 13479. "Castanhal" é outra cidade (cód. 27 e 28). Para as demais lojas: `bash egestor.sh clientes "LIDER"`.

# Regra operacional
- Cliente e produtos citados precisam ser resolvidos contra o cadastro real. Sem correspondência exata (ex.: "Castanheira" vs "Castanhal", "caldo" vs "suco"), o Claude escolhe a interpretação mais plausível mas SEMPRE explicita a resolução no resumo antes de emitir.
- O Claude só transmite (`--enviar` / "Salvar e enviar") depois de confirmação explícita da Tainara no chat.

# Histórico
- Login automatizado repetido gerou captcha; resolvido com login manual da Tainara (via Edge). Mais um motivo pra usar a API.
- O painel do navegador do Claude às vezes não renderiza se a aba não estiver visível na tela.
- Primeira nota real: NF-e 13479, cliente LIDER COMERCIO E INDUSTRIA LTDA (Bairro Castanheira, Belém), 9 itens de suco de cana (330ml/500ml/1L x natural/limão/laranja), qtd 10 cada, total produtos R$566,00, total NF R$587,50, em 27/08/2026 — emitida pelo navegador. **Depois foi cancelada** (situação 90).
- **Primeira nota pela API: NF-e 13489**, 27/08/2026 22:12. Venda 3709 / nota cód. 3849. LIDER CASTANHEIRA (cód. 5). 20×330ML + 15×500ML + 5×1L tradicional = produtos R$179,75 + ICMS-ST R$6,82 = **R$186,57**. Chave 15260823388480000105550010000134891309772650, protocolo 215260047861307, cStat 100. Venda criada pela API; transmissão pela tela porque o rascunho já existia. DANFE e XML em `notas/`. **Era teste — cancelada no mesmo dia**, justificativa "quantidade de produtos errada", cStat 135, situação 90. A venda 3709 continua no sistema.
- Na listagem de agosto/2026 aparecem ~140 notas, várias já vinculadas a vendas (13486/3706, 13487/3707, 13488/3708) — ou seja, o caminho "emitir a partir da venda" já era o normal nessa conta antes da API.

# Arquivos desta pasta
- `contexto-egestor.md` — este documento.
- `egestor.sh` — helper de linha de comando para a API (bash + curl).
- `emitir.sh` — emite uma NF-e inteira em uma linha: `emitir.sh <codContato> <cod:qtd>...`
- `app/pedidos.html` — fonte do app de pedidos do Jean (republicar mantém a URL).
- `app/clientes.json`, `app/produtos.json` — dados embutidos no app, gerados do cache.
- `modelo-venda.json` — template do payload de venda.
- `token.local` — personal_token (criar manualmente, não versionado).
- `cache/produtos.json`, `cache/clientes.json` — cadastro baixado (`egestor.sh catalogo`).
- `notas/` — DANFEs e XMLs baixados.

Para regerar os dados do app depois de mudanças no cadastro:
```bash
bash egestor.sh catalogo
```
e então reinjetar `app/clientes.json` / `app/produtos.json` no `app/pedidos.html` e republicar.
