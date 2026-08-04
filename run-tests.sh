#!/bin/bash
# Batteria di test COBRA. Uso: ./run-tests.sh
cd "$(dirname "$0")" || exit 1
FAIL=0
TESTS="tests/verify-all.js tests/test-tool-pipeline.js tests/check-ctx-methods.js tests/check-bridge-protocol.js tests/test-kb-search.js tests/test-ssrf.js tests/test-security-runtime.js tests/test-data-integrity.js tests/test-learning.js"
for t in $TESTS; do
  printf "%-38s " "$(basename $t)"
  OUT=$(timeout 120 node "$t" 2>&1)
  if [ $? -eq 0 ]; then
    echo "$OUT" | grep -oE "RISULTATO: [0-9]+ PASS[^)]*" | head -1 || echo "OK"
  else
    FAIL=1
    echo "FALLITO"
    echo "$OUT" | grep -E "31mx|✗" | head -5
  fi
done
echo ""
[ "$FAIL" = "0" ] && echo "== TUTTI I TEST PASSATI ==" || echo "== CI SONO TEST FALLITI =="
exit $FAIL
