#!/bin/sh
# Runs the suite under Node's own coverage, and fails under a floor.
#
# Two things this stops, the same two as in the other NYX repositories:
#   * `node --test` reports a file it could not load as one passing test, so a broken suite used to
#     look green;
#   * nothing measured how much of `sources/` the tests exercise — 8 tests covered `lib/auth.js`
#     and the server itself was never even loaded.
#
# The floor is the level actually measured, never a wish: 98 % lines / 95 % branches on 2026-11-09
# (measured 99,57 / 95,73), when `tests/ws_server.test.js` started driving the real handlers with
# doubles for `ws`, `mqtt`, `redis` and `log4js`. Raise it as tests land, never lower it.
#
# `node --test` needs Node 18+; the runtime image is still Node 13, which only runs the server.
set -eu

FLOOR=98
BRANCH_FLOOR=95

cd "$(dirname "$0")/.."

# `tests/` seul ne resout pas sur Node 22 (`Cannot find module .../tests`) : la liste des fichiers
# est donnee par le shell, qui la resout partout.
if ! REPORT=$(node --test --experimental-test-coverage tests/*.test.js 2>&1); then
    printf '%s\n' "$REPORT"
    echo "ci_test: the suite failed" >&2
    exit 1
fi

printf '%s\n' "$REPORT" | grep -E '^(ℹ|✖|✔)' | tail -20

# Une suite vide rapporte 100 % : sans ce garde, un motif qui ne trouve plus de fichier passerait
# pour une couverture parfaite.
count=$(printf '%s\n' "$REPORT" | awk '/^ℹ tests /{print $3}')
if [ "${count:-0}" = "0" ] || [ -z "${count:-}" ]; then
    printf '%s\n' "$REPORT"
    echo "ci_test: no test ran — check the file pattern" >&2
    exit 1
fi

skipped=$(printf '%s\n' "$REPORT" | awk '/^ℹ skipped /{print $3}')
if [ "${skipped:-0}" != "0" ]; then
    echo "ci_test: $skipped test(s) skipped — a skipped test disables itself in silence" >&2
    exit 1
fi

total=$(printf '%s\n' "$REPORT" | awk -F'|' '/all files/{gsub(/ /, "", $2); print $2}')
branches=$(printf '%s\n' "$REPORT" | awk -F'|' '/all files/{gsub(/ /, "", $3); print $3}')

if [ -z "$total" ]; then
    echo "ci_test: no coverage summary in the report — the measure changed shape" >&2
    exit 1
fi

awk -v total="$total" -v floor="$FLOOR" 'BEGIN{if (total < floor) {printf "ci_test: coverage %s %% is under the floor of %s %%\n", total, floor; exit 1}}'
awk -v branches="$branches" -v floor="$BRANCH_FLOOR" 'BEGIN{if (branches < floor) {printf "ci_test: branches %s %% is under the floor of %s %%\n", branches, floor; exit 1}}'

# La CI envoie ce fichier sur la branche `badges` (job de publication, master seulement).
if [ -n "${BADGE_OUT:-}" ]; then
    mkdir -p "$(dirname "$BADGE_OUT")"
    cat > "$BADGE_OUT" <<EOF
{
  "schemaVersion": 1,
  "label": "coverage",
  "message": "$total%",
  "color": "brightgreen",
  "value": $total
}
EOF
fi

echo "ci_test: $total % lines, $branches % branches (floor $FLOOR / $BRANCH_FLOOR)"
