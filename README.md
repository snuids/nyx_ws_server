# nyx_ws_server

Use the following environment variables:

- AMQC_URL=****
- AMQC_LOGIN=****
- AMQC_PASSWORD=********
- AMQC_PORT=1883
- IN_TOPIC=TO_WEBSOCKETS
- "CONFIG=[{ 'name': 'MCS1', 'port': 8280 },{ 'name': 'MCS2', 'port': 8281 }]"

# TESTS

```shell
node --test tests/            # the suite
sh scripts/ci_test.sh         # what the CI runs: the suite, and a floor under its coverage
```

`node --test` needs Node 18+; the runtime image is still Node 13, which only runs the server.

Two files, two jobs:

- `tests/auth.test.js` pins the identity rules of `lib/auth.js` — which keys a `nyx_user` document
  offers, which token address the API writes, when a stored account matches the claimed one, and
  what a log line may never carry;
- `tests/ws_server.test.js` drives the server itself. `sources/ws_server.js` is written to *be* a
  service (everything at module level: the Redis client, the broker link, one `WebSocket.Server`
  per configured target, two timers), so it is loaded with doubles in place of `ws`, `mqtt`, `redis`
  and `log4js`, and the tests trigger the real handlers: a connection, a control frame, a relayed
  payload, a life sign, a SIGTERM.

What that pins down is what a running process cannot show: which client receives a message, whether
a socket is allowed to publish into the broker at all, and that a refused socket is closed with
**4401** rather than left open.

Coverage is measured by `sh scripts/ci_test.sh` and gated at **98 % lines / 95 % branches**
(measured on 2026-11-09: 99,57 / 95,73 — `ws_server.js` 99,48 %, `auth.js` 100 %). The floor is the
level actually measured, never a wish; it moves up with the tests, never down. The badge on the
`badges` branch is published by `.github/workflows/ci-tests.yml` on `master`.
