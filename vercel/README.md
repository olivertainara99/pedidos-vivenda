# Pedidos Vivenda dos Sucos

App web do pedido até a nota fiscal. O Jean anota, a Tainara autoriza, e a NF-e
sai sozinha pela API do eGestor.

## Como funciona

Não existe banco de dados. **Os pedidos moram no próprio eGestor**, como Orçamentos
marcados com a tag `APP_PEDIDOS`:

| passo | o que acontece no eGestor |
|---|---|
| Jean lança um pedido | `POST /vendas` com `situacao: 10` (Orçamento) e a tag `APP_PEDIDOS` |
| Tainara abre a fila | `GET /vendas?tipo=10&filtro=APP_PEDIDOS` |
| Tainara autoriza | `PUT /vendas/{cod}` com `situacao: 50` — o orçamento vira Venda |
| CFOP 5401 | `POST /vendas/{cod}/gerarNfe` com `enviar: true` — a nota sai na hora |
| CFOP 5917 / 5113 | para por aqui: a venda fica pronta e a nota sai pela tela |
| Tainara recusa | continua Orçamento, com `RECUSADO` na observação |
| Tainara exclui | `DELETE /vendas/{cod}` |

O CFOP escolhido fica gravado em `customizado.xCampo1` ("Observações gerais"),
junto com quem lançou. É o único campo que a API deixa alterar depois que a venda
já existe.

### Por que 5917 e 5113 não saem sozinhas

A API do eGestor **não tem campo de CFOP nem de natureza da operação**. Uma nota
emitida por ela sai sempre com o padrão da conta, 5401. Então esses dois CFOPs
viram venda pronta e o app avisa para emitir pela tela: Fiscal > NF-e > Nova,
trocando a natureza da operação em "Dados gerais".

## Segurança

- O `personal_token` do eGestor fica **só no servidor**, como variável de ambiente.
  Nunca é enviado ao navegador.
- Sessão em cookie `HttpOnly` + `Secure` + `SameSite=Lax`, assinado com HMAC-SHA256.
  Ninguém consegue trocar o próprio papel editando o cookie.
- Senha por papel, comparada em tempo constante.
- Os **preços vêm sempre do cadastro** no momento do lançamento, nunca do que o
  navegador mandou. O cliente só escolhe código de produto e quantidade.
- Só a Tainara chega em `/api/autorizar` e no DELETE.

É proteção adequada para duas pessoas de confiança, não para uso público. A senha
é compartilhada por papel — se alguém sair da empresa, troque a variável na Vercel.

## Variáveis de ambiente (Vercel)

| variável | o que é |
|---|---|
| `EGESTOR_PERSONAL_TOKEN` | o token gerado em eGestor > Configurações > API |
| `SENHA_JEAN` | senha de quem anota |
| `SENHA_TAINARA` | senha de quem autoriza |
| `SESSION_SECRET` | frase longa e aleatória, só para assinar o cookie |

## Estrutura

```
index.html          o app inteiro (HTML + CSS + JS, sem framework)
api/_egestor.js     ponte com a API do eGestor
api/_sessao.js      cookie assinado e checagem de papel
api/login.js        entrar, sair, saber quem está logado
api/catalogo.js     clientes e produtos (cache de 10 min)
api/pedidos.js      listar, criar e apagar pedidos
api/autorizar.js    autorizar/recusar — o passo que emite a nota
```

Sem dependências e sem build: a Vercel serve o `index.html` e roda cada arquivo
de `api/` como função serverless. Arquivos começando com `_` não viram rota.

## Limites conhecidos

- A API do eGestor aceita **60 requisições por minuto**. A lista de pedidos gasta
  1 chamada + 1 por pedido (limitado a 30), então uma fila muito grande pode
  encostar no limite.
- `PUT /vendas/{cod}` **zera a situação** se o campo `situacao` não for enviado
  junto. O código sempre manda.
- `situacaoOS` só aceita "Em espera", "Em execução", "Finalizada" ou "Entregue" —
  por isso o estado do app vai na observação, não ali.
