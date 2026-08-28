#!/usr/bin/env bash
# Helper de linha de comando para a API do eGestor (https://api.egestor.com.br/api/v1)
# Uso pelo Claude para emitir NF-e via módulo Vendas, sem automação de navegador.
# Requisitos: bash + curl (Git Bash no Windows já tem os dois).

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://api.egestor.com.br/api"
PERSONAL_FILE="$DIR/token.local"      # arquivo com o personal_token (NÃO versionar)
TOKEN_FILE="$DIR/.access_token"       # cache do access_token (expira em 900s)
TOKEN_MAX_AGE=800

die() { echo "ERRO: $*" >&2; exit 1; }

# --- autenticação ---------------------------------------------------------
auth() {
  if [[ -f "$TOKEN_FILE" ]]; then
    local age=$(( $(date +%s) - $(stat -c %Y "$TOKEN_FILE") ))
    if (( age < TOKEN_MAX_AGE )); then cat "$TOKEN_FILE"; return 0; fi
  fi
  [[ -f "$PERSONAL_FILE" ]] || die "crie $PERSONAL_FILE com o personal_token (eGestor > Configurações > aba API)."
  local personal resp token
  personal="$(tr -d ' \t\r\n' < "$PERSONAL_FILE")"
  [[ -n "$personal" ]] || die "$PERSONAL_FILE está vazio."
  resp="$(curl -s -X POST "$API/oauth/access_token" \
          -H 'Content-Type: application/json' \
          -d "{\"grant_type\":\"personal\",\"personal_token\":\"$personal\"}")"
  token="$(printf '%s' "$resp" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)"
  [[ -n "$token" ]] || die "falha ao obter access_token. Resposta: $resp"
  printf '%s' "$token" > "$TOKEN_FILE"
  printf '%s' "$token"
}

req() { # req METODO /caminho [json]
  local method="$1" path="$2" body="${3:-}" tk
  tk="$(auth)" || exit 1
  if [[ -n "$body" ]]; then
    curl -s -X "$method" "$API/v1${path}" \
      -H "Authorization: Bearer $tk" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -X "$method" "$API/v1${path}" -H "Authorization: Bearer $tk"
  fi
}

# quebra o JSON em linhas por registro, só para leitura humana
fmt() { sed -e 's/},{/}\n{/g' -e 's/^{"total"/{"total"/'; }

urlenc() { # percent-encode byte a byte (seguro para acentos em UTF-8)
  local s="$1" out="" i c
  local LC_ALL=C
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

usage() {
  cat <<'USO'
Uso: ./egestor.sh <comando> [args]

  empresa                      Dados da empresa emitente (teste de conexão)
  clientes <termo>             Busca contatos por nome/fantasia/cpfcnpj
  produtos [termo]             Busca produtos (sem termo = lista a 1a página)
  catalogo                     Baixa TODOS os produtos para cache/produtos.json
  get <caminho>                GET cru, ex: get "/vendas?filtro=LIDER"
  post <caminho> <arquivo>     POST cru com corpo vindo de um arquivo .json
  venda <arquivo.json>         Cria a venda (POST /vendas)
  nfe <codVenda>               Gera a NF-e SEM enviar (situação "Criada") - seguro
  nfe <codVenda> --enviar      Gera E TRANSMITE à SEFAZ - IRREVERSÍVEL
  nfe-status <codNota>         Consulta situação da nota
  danfe <codNota> <saida.pdf>  Baixa o DANFE em PDF
  xml <codNota> <saida.xml>    Baixa o XML autorizado
USO
}

cmd="${1:-}"; shift || true
case "$cmd" in
  empresa)   req GET "/empresa" | fmt ;;
  clientes)  [[ $# -ge 1 ]] || die "informe o termo de busca."
             req GET "/contatos?filtro=$(urlenc "$1")&fields=codigo,nome,fantasia,cpfcnpj,cidade,uf,bairro,logradouro,indicadorIE,inscricaoEstadual,clienteFinal" | fmt ;;
  produtos)  if [[ $# -ge 1 ]]; then
               req GET "/produtos?filtro=$(urlenc "$1")&fields=codigo,descricao,precoVenda,estoque,unidadeTributada,ncm&orderBy=descricao,asc" | fmt
             else
               req GET "/produtos?fields=codigo,descricao,precoVenda,unidadeTributada&orderBy=descricao,asc" | fmt
             fi ;;
  catalogo)  mkdir -p "$DIR/cache"; : > "$DIR/cache/produtos.json"
             p=1
             while :; do
               out="$(req GET "/produtos?page=$p&fields=codigo,descricao,precoVenda,unidadeTributada,ncm&orderBy=descricao,asc")"
               printf '%s\n' "$out" | fmt >> "$DIR/cache/produtos.json"
               last="$(printf '%s' "$out" | grep -o '"last_page":[0-9]*' | head -1 | cut -d: -f2)"
               [[ -z "$last" || "$p" -ge "$last" ]] && break
               p=$((p+1))
             done
             echo "Catálogo salvo em cache/produtos.json ($p página(s))." ;;
  get)       [[ $# -ge 1 ]] || die "informe o caminho."; req GET "$1" | fmt ;;
  put)       [[ $# -ge 2 ]] || die "uso: put <caminho> <json-inline>"
             req PUT "$1" "$2" | fmt ;;
  post)      [[ $# -ge 2 ]] || die "uso: post <caminho> <arquivo.json>"
             req POST "$1" "$(cat "$2")" | fmt ;;
  venda)     [[ $# -ge 1 ]] || die "uso: venda <arquivo.json>"
             [[ -f "$1" ]] || die "arquivo $1 não encontrado."
             req POST "/vendas" "$(cat "$1")" | fmt ;;
  nfe)       [[ $# -ge 1 ]] || die "uso: nfe <codVenda> [--enviar]"
             cod="$1"; enviar=false
             [[ "${2:-}" == "--enviar" ]] && enviar=true
             if [[ "$enviar" == true ]]; then
               echo ">>> TRANSMITINDO NF-e da venda $cod para a SEFAZ (produção, irreversível)" >&2
             fi
             req POST "/vendas/$cod/gerarNfe" "{\"enviar\":$enviar,\"contigOffline\":false}" | fmt ;;
  nfe-status)[[ $# -ge 1 ]] || die "uso: nfe-status <codNota>"; req GET "/nfe/$1" | fmt ;;
  danfe)     [[ $# -ge 2 ]] || die "uso: danfe <codNota> <saida.pdf>"
             tk="$(auth)"; curl -s -H "Authorization: Bearer $tk" "$API/v1/nfe/$1/danfe" -o "$2" && echo "salvo em $2" ;;
  xml)       [[ $# -ge 2 ]] || die "uso: xml <codNota> <saida.xml>"
             tk="$(auth)"; curl -s -H "Authorization: Bearer $tk" "$API/v1/nfe/$1/xml" -o "$2" && echo "salvo em $2" ;;
  ""|-h|--help|help) usage ;;
  *)         usage; exit 1 ;;
esac
