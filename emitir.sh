#!/usr/bin/env bash
# Emite uma NF-e a partir de um pedido, em uma única linha de comando.
#
#   bash emitir.sh <codContato> <codProduto:qtd> [<codProduto:qtd> ...]
#   bash emitir.sh 5 1:20 2:15 3:5              -> cria a venda E transmite à SEFAZ
#   bash emitir.sh --rascunho 5 1:20 2:15       -> cria a venda e gera a nota SEM transmitir
#
# Os preços vêm do cadastro do eGestor no momento da emissão (não de cache).

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COD_VENDEDOR=3          # Tainara

die(){ echo "ERRO: $*" >&2; exit 1; }

ENVIAR=true
if [[ "${1:-}" == "--rascunho" ]]; then ENVIAR=false; shift; fi
[[ $# -ge 2 ]] || die "uso: bash emitir.sh [--rascunho] <codContato> <codProduto:qtd> [...]"

CONTATO="$1"; shift
[[ "$CONTATO" =~ ^[0-9]+$ ]] || die "codContato inválido: $CONTATO"

# --- catálogo fresco, uma chamada só ---
CAT="$(bash "$DIR/egestor.sh" get "/produtos?fields=codigo,descricao,precoVenda&orderBy=codigo,asc")"
[[ "$CAT" == *'"codigo"'* ]] || die "não consegui ler o catálogo. Resposta: $(head -c 200 <<< "$CAT")"

preco_de(){ grep -o "{\"codigo\":$1,[^}]*}" <<< "$CAT" | grep -o '"precoVenda":[0-9.]*' | head -1 | cut -d: -f2; }
nome_de(){  grep -o "{\"codigo\":$1,[^}]*}" <<< "$CAT" | grep -o '"descricao":"[^"]*"' | head -1 | cut -d'"' -f4; }

ITENS=""; TOTAL=0
for par in "$@"; do
  cod="${par%%:*}"; qtd="${par##*:}"
  [[ "$cod" =~ ^[0-9]+$ && "$qtd" =~ ^[0-9]+$ && "$qtd" -gt 0 ]] || die "item inválido: $par (use codProduto:qtd)"
  p="$(preco_de "$cod")"
  [[ -n "$p" ]] || die "produto $cod não encontrado no catálogo."
  echo "  $qtd x $(nome_de "$cod")  @ $p"
  [[ -n "$ITENS" ]] && ITENS="$ITENS,"
  ITENS="$ITENS{\"codProduto\":$cod,\"quant\":$qtd,\"preco\":$p,\"vDesc\":0}"
  TOTAL="$(awk -v t="$TOTAL" -v q="$qtd" -v p="$p" 'BEGIN{printf "%.2f", t + q*p}')"
done
echo "  --- produtos: R$ $TOTAL"

CORPO="{\"codContato\":$CONTATO,\"codVendedor\":$COD_VENDEDOR,\"dtVenda\":\"$(date +%F)\",\"situacao\":50,\"tags\":[\"NF_VIA_API\"],\"produtos\":[$ITENS]}"

VENDA="$(bash "$DIR/egestor.sh" post "/vendas" <(printf '%s' "$CORPO"))"
COD_VENDA="$(grep -o '"codigo":[0-9]*' <<< "$VENDA" | head -1 | cut -d: -f2)"
[[ -n "$COD_VENDA" ]] || die "falha ao criar a venda: $VENDA"
echo "  venda $COD_VENDA criada"

if [[ "$ENVIAR" == true ]]; then
  bash "$DIR/egestor.sh" nfe "$COD_VENDA" --enviar
else
  bash "$DIR/egestor.sh" nfe "$COD_VENDA"
fi
