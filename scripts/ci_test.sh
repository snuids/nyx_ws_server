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

# `tests/` alone does not resolve on Node 22 (`Cannot find module .../tests`): the list of files
# is produced by the shell, which resolves it everywhere.
# `--test-reporter=spec` fixes the shape of the report (the default reporter switches to TAP when
# there is no TTY, which is exactly the CI case, and prefixes every line with `# `).
# `--test-coverage-exclude` keeps the tests themselves out of the measure: the ratio has to be about
# `sources/`, not about the files doing the measuring.
if ! REPORT=$(node --test --experimental-test-coverage --test-reporter=spec \
        --test-coverage-exclude='tests/**' tests/*.test.js 2>&1); then
    printf '%s\n' "$REPORT"
    echo "ci_test: the suite failed" >&2
    exit 1
fi

# The report prefix (`ℹ ` in spec, `# ` in TAP) is stripped before parsing.
CLEAN=$(printf '%s\n' "$REPORT" | sed 's/^[[:space:]]*[#ℹ]\{0,1\}[[:space:]]*//')
printf '%s\n' "$CLEAN" | grep -E '^(tests|pass|fail|skipped|all files)' | tail -8
printf '%s\n' "$REPORT" | tail -16

# An empty suite reports 100 %: without this guard, a pattern that stopped matching files would
# read as perfect coverage.
count=$(printf '%s\n' "$CLEAN" | awk '/^tests /{print $2}')
if [ "${count:-0}" = "0" ] || [ -z "${count:-}" ]; then
    printf '%s\n' "$REPORT"
    echo "ci_test: no test ran — check the file pattern" >&2
    exit 1
fi

skipped=$(printf '%s\n' "$CLEAN" | awk '/^skipped /{print $2}')
if [ "${skipped:-0}" != "0" ]; then
    echo "ci_test: $skipped test(s) skipped — a skipped test disables itself in silence" >&2
    exit 1
fi

total=$(printf '%s\n' "$CLEAN" | awk -F'|' '/^all files/{gsub(/ /, "", $2); print $2}')
branches=$(printf '%s\n' "$CLEAN" | awk -F'|' '/^all files/{gsub(/ /, "", $3); print $3}')

if [ -z "$total" ]; then
    echo "ci_test: no coverage summary in the report — the measure changed shape" >&2
    exit 1
fi

awk -v total="$total" -v floor="$FLOOR" 'BEGIN{if (total < floor) {printf "ci_test: coverage %s %% is under the floor of %s %%\n", total, floor; exit 1}}'
awk -v branches="$branches" -v floor="$BRANCH_FLOOR" 'BEGIN{if (branches < floor) {printf "ci_test: branches %s %% is under the floor of %s %%\n", branches, floor; exit 1}}'

# CI pushes this file to the `badges` branch (publish job, master only).
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
