#!/bin/bash
# Batteria di test COBRA. Uso: ./run-tests.sh
#
# ══════════════════════════════════════════════════════════════════════
# PERCHE' L'ELENCO NON SI SCRIVE PIU' A MANO
#
# Fino al 9 agosto qui c'era una riga TESTS="..." con i nomi dei file, scritta
# a mano. In tests/ c'erano 68 file; in quella riga ne comparivano 47.
#
# Ventuno test scritti e mai eseguiti. Fra questi:
#
#   test-sguardo.js                  la prova di guarda_pagina, che il giorno
#                                    dopo e' fallito tre volte su tre
#   test-strumenti-raggiungibili.js  la prova che uno strumento dichiarato
#                                    arrivi davvero al modello
#   test-un-ponte-solo.js            la prova che di bridgeCommand ce ne sia uno
#   test-una-sola-definizione-di-fatto.js
#
# Cioe': le prove che avrebbero intercettato i guasti della settimana esistevano
# gia', ed erano scritte bene. Semplicemente nessuno le eseguiva, perche' il
# loro nome non era stato aggiunto a una stringa.
#
# "500 test passati" era vero e insieme falso: 500 su un elenco scelto a mano
# che escludeva proprio quelli che contavano.
#
# E' la stessa malattia dei sei registri delle capacita': una lista manuale che
# nessuno confronta con la realta'. Qui la cura e' banale — i test si TROVANO,
# non si elencano.
# ══════════════════════════════════════════════════════════════════════

cd "$(dirname "$0")" || exit 1
FAIL=0
FALLITI=""

# verify-all per primo: e' il piu' grosso e se cade il resto conta poco.
TESTS="tests/verify-all.js $(ls tests/test-*.js tests/check-*.js 2>/dev/null | grep -v 'tests/verify-all.js' | sort)"

for t in $TESTS; do
  [ -f "$t" ] || continue
  printf "%-42s " "$(basename "$t")"
  OUT=$(timeout 120 node "$t" 2>&1)
  if [ $? -eq 0 ]; then
    echo "$OUT" | grep -oE "RISULTATO: [0-9]+ PASS[^)]*|✓ [^$]*" | head -1 || echo "OK"
  else
    FAIL=1
    FALLITI="$FALLITI $(basename "$t")"
    echo "FALLITO"
    echo "$OUT" | grep -E "31mx|✗|AssertionError|Error:" | head -5
  fi
done

echo ""
echo "test eseguiti: $(echo $TESTS | wc -w)"
if [ "$FAIL" = "0" ]; then
  echo "== TUTTI I TEST PASSATI =="
else
  echo "== FALLITI:$FALLITI =="
fi
exit $FAIL
