/**
 * Tests for the WebSocket server itself.
 *
 * `sources/ws_server.js` is written to *be* a service: everything at module level — the Redis
 * client, the MQTT link, one `WebSocket.Server` per configured target, two timers — which is why
 * it had no test and no measure. It is loaded here with doubles in place of `ws`, `mqtt`, `redis`
 * and `log4js`, so a test drives the real handlers: a connection, a control frame, a relayed
 * payload, a life sign, a SIGTERM.
 *
 * What is pinned down is what a running process cannot show you: which client receives a message,
 * whether a socket is allowed to publish at all, and that a refused socket is closed with 4401
 * rather than left open. The token rules themselves live in `lib/auth.js` and have their own file.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

const SOURCES = path.join(__dirname, "..", "sources");
const SERVER = path.join(SOURCES, "ws_server.js");

const ALICE = { id: "alice@example.com", login: "alice", privileges: ["A1"] };
const TOKEN = "e5b0c1d2ab";

/** Le journal: on retient les lignes pour verifier ce qui ne doit pas y apparaitre. */
class FakeLogger {
  constructor() {
    this.lines = [];
  }
  info(message) {
    this.lines.push(["info", String(message)]);
  }
  warn(message) {
    this.lines.push(["warn", String(message)]);
  }
  error(message) {
    this.lines.push(["error", String(message)]);
  }
  setLevel() {}
  text() {
    return this.lines.map(([, line]) => line).join("\n");
  }
  reasons() {
    return this.lines.filter(([level]) => level !== "info").map(([, line]) => line);
  }
}

class FakeSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.handlers = {};
    this.sent = [];
    this.closed = [];
    this.terminated = 0;
  }
  on(event, handler) {
    (this.handlers[event] = this.handlers[event] || []).push(handler);
  }
  emit(event, ...args) {
    (this.handlers[event] || []).forEach((handler) => handler(...args));
  }
  send(payload) {
    this.sent.push(payload);
  }
  close(code, reason) {
    this.closed.push([code, reason]);
    this.readyState = 3;
  }
  terminate() {
    this.terminated += 1;
  }
  payloads() {
    return this.sent.map((payload) => JSON.parse(payload));
  }
}

class FakeServer {
  constructor(options) {
    this.options = options;
    this.handlers = {};
    this.clients = new Set();
    this.closed = false;
    FakeServer.instances.push(this);
  }
  on(event, handler) {
    (this.handlers[event] = this.handlers[event] || []).push(handler);
  }
  emit(event, ...args) {
    (this.handlers[event] || []).forEach((handler) => handler(...args));
  }
  close() {
    this.closed = true;
  }
  /** Un client se connecte, comme le ferait `ws` sur une poignee de main. */
  connect(socket = new FakeSocket()) {
    this.clients.add(socket);
    this.emit("connection", socket, { connection: { remoteAddress: "10.0.0.5" } });
    return socket;
  }
}

FakeServer.instances = [];

class FakeMqtt {
  constructor() {
    this.handlers = {};
    this.published = [];
    this.subscriptions = [];
    this.ended = false;
  }
  on(event, handler) {
    (this.handlers[event] = this.handlers[event] || []).push(handler);
  }
  emit(event, ...args) {
    (this.handlers[event] || []).forEach((handler) => handler(...args));
  }
  subscribe(topic, callback) {
    this.subscriptions.push(topic);
    if (callback) {
      callback(null);
    }
  }
  publish(topic, message) {
    this.published.push([topic, message]);
  }
  end() {
    this.ended = true;
  }
  bodies(topic) {
    return this.published.filter(([name]) => name === topic).map(([, body]) => JSON.parse(body));
  }
}

class FakeRedis {
  constructor() {
    this.store = {};
    this.error = null;
    this.quits = 0;
    this.handlers = {};
  }
  on(event, handler) {
    (this.handlers[event] = this.handlers[event] || []).push(handler);
  }
  emit(event, ...args) {
    (this.handlers[event] || []).forEach((handler) => handler(...args));
  }
  get(key, callback) {
    callback(this.error, this.store[key] === undefined ? null : this.store[key]);
  }
  quit() {
    this.quits += 1;
  }
}

/**
 * Charge `ws_server.js` avec les doubles en place et rend la poignee de mains.
 *
 * `require` est intercepte le temps du chargement: le serveur est un script, pas un module, il
 * prend `ws`, `mqtt`, `redis` et `log4js` au moment ou on l'evalue.
 */
function loadServer(options = {}) {
  const logger = new FakeLogger();
  const mqtt = new FakeMqtt();
  const redis = new FakeRedis();
  const timers = { intervals: [], timeouts: [] };
  const exits = [];

  const config =
    options.config ||
    [
      { name: "HHTs", port: 59999, lifesign: true, forward_topic: "HHTMessages" },
      { name: "Console", port: 59998 },
      { name: "Devices", port: 59997, allow_anonymous: true, forward_topic: "DeviceMessages" },
      { name: "Quiet", port: 59996, lifesign: false },
    ];

  const saved = {
    CONFIG: process.env.CONFIG,
    IN_TOPIC: process.env.IN_TOPIC,
    AMQC_URL: process.env.AMQC_URL,
  };
  const configJson = JSON.stringify(config).replace(/"/g, "'");
  process.env.CONFIG = configJson;
  process.env.IN_TOPIC = "NYX_WS_IN";
  process.env.AMQC_URL = "broker.example";

  const originalRequire = Module.prototype.require;
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  const originalExit = process.exit;

  FakeServer.instances = [];

  Module.prototype.require = function (name) {
    if (name === "log4js") {
      return { getLogger: () => logger, configure: () => {} };
    }
    if (name === "ws") {
      return { OPEN: 1, Server: FakeServer };
    }
    if (name === "mqtt") {
      return { connect: () => mqtt };
    }
    if (name === "redis") {
      return { createClient: () => redis };
    }
    return originalRequire.apply(this, arguments);
  };
  global.setInterval = (callback, delay) => {
    timers.intervals.push({ callback, delay });
    return { unref: () => {} };
  };
  global.setTimeout = (callback, delay) => {
    timers.timeouts.push({ callback, delay });
    return { unref: () => {} };
  };
  process.exit = (code) => {
    exits.push(code);
  };

  try {
    delete require.cache[require.resolve(SERVER)];
    require(SERVER);
  } finally {
    Module.prototype.require = originalRequire;
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
    process.exit = originalExit;
    if (saved.CONFIG === undefined) {
      delete process.env.CONFIG;
    } else {
      process.env.CONFIG = saved.CONFIG;
    }
    if (saved.IN_TOPIC !== undefined) {
      process.env.IN_TOPIC = saved.IN_TOPIC;
    }
    if (saved.AMQC_URL !== undefined) {
      process.env.AMQC_URL = saved.AMQC_URL;
    }
  }

  const server = {
    logger,
    mqtt,
    redis,
    timers,
    exits,
    // La configuration telle que le serveur l'a lue: `env CONFIG` est reanalyse a l'evaluation,
    // donc c'est une copie, et c'est celle-la qu'il faut interroger.
    config: JSON.parse(configJson.replace(/'/g, '"')),
    target(name) {
      const index = config.findIndex((entry) => entry.name === name);
      return { entry: config[index], server: FakeServer.instances[index] };
    },
    /** Le serveur de `name`, connecte un client et le rend. */
    connect(name, socket) {
      return server.target(name).server.connect(socket);
    },
    /** Un client s'authentifie: le jeton est dans le magasin, il appartient au compte. */
    authenticate(name, socket, account = ALICE, keys = { user: account }) {
      redis.store["nyx_tok_" + TOKEN] = JSON.stringify(account);
      socket.emit("message", JSON.stringify({ token: TOKEN, user: keys.user }));
      return socket;
    },
    interval(index) {
      return timers.intervals[index] && timers.intervals[index].callback;
    },
    /** Execute `fn` en capturant les minuteries qu'elle pose (delai d'authentification, arret). */
    captureTimers(fn) {
      const savedTimeout = global.setTimeout;
      const savedInterval = global.setInterval;
      global.setTimeout = (callback, delay) => {
        timers.timeouts.push({ callback, delay });
        return { unref: () => {} };
      };
      global.setInterval = (callback, delay) => {
        timers.intervals.push({ callback, delay });
        return { unref: () => {} };
      };
      try {
        return fn();
      } finally {
        global.setTimeout = savedTimeout;
        global.setInterval = savedInterval;
      }
    },
    lastTimeout() {
      return timers.timeouts[timers.timeouts.length - 1];
    },
    cleanup() {
      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("unhandledRejection");
      process.removeAllListeners("uncaughtException");
    },
  };
  return server;
}

/** Un test qui charge le serveur doit retirer ses ecouteurs de signal ensuite. */
function withServer(t, options) {
  const server = loadServer(options);
  t.after(() => server.cleanup());
  return server;
}

test("the broker link subscribes to the configured topic", (t) => {
  const server = withServer(t);

  server.mqtt.emit("connect");

  assert.deepStrictEqual(server.mqtt.subscriptions, ["NYX_WS_IN"]);
});

test("a new connection announces itself on NYX_WS_INFO", (t) => {
  const server = withServer(t);

  server.connect("HHTs");

  const announcements = server.mqtt.bodies("NYX_WS_INFO");
  assert.strictEqual(announcements.length, 1);
  assert.deepStrictEqual(announcements[0], { Name: "HHTs", Port: 59999, IP: "10.0.0.5" });
});

test("a message addressed to a login on a target reaches that socket", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  server.authenticate("HHTs", socket);

  server.mqtt.emit(
    "message",
    "NYX_WS_IN",
    Buffer.from(JSON.stringify({ login: "alice@example.com", target: "HHTs", data: { value: 42 } }))
  );

  assert.deepStrictEqual(socket.payloads(), [{ type: "message", data: { value: 42 } }]);
});

test("a message addressed to a login alone finds the target it is on", (t) => {
  const server = withServer(t);
  const socket = server.connect("Console");
  server.authenticate("Console", socket);

  server.mqtt.emit(
    "message",
    "NYX_WS_IN",
    Buffer.from(JSON.stringify({ login: "alice", data: { value: 7 }, type: "alert" }))
  );

  assert.deepStrictEqual(socket.payloads(), [{ type: "alert", data: { value: 7 } }]);
});

test("a message addressed to a target alone is broadcast to its open clients", (t) => {
  const server = withServer(t);
  const one = server.connect("HHTs");
  const other = server.connect("HHTs");

  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ target: "HHTs", data: { n: 1 } })));

  assert.deepStrictEqual(one.payloads(), [{ type: "message", data: { n: 1 } }]);
  assert.deepStrictEqual(other.payloads(), [{ type: "message", data: { n: 1 } }]);
});

test("a closed socket is not written to during a broadcast", (t) => {
  const server = withServer(t);
  const open = server.connect("HHTs");
  const closed = server.connect("HHTs");
  closed.readyState = 3; // CLOSED: `send` would buffer silently and report success

  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ target: "HHTs", data: { n: 2 } })));

  assert.strictEqual(open.payloads().length, 1);
  assert.strictEqual(closed.sent.length, 0);
});

test("an unknown target is logged and dropped", (t) => {
  const server = withServer(t);

  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ target: "Nope", data: {} })));

  assert.ok(server.logger.reasons().includes("Unknown target."));
});

test("a message without data is dropped", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");

  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ target: "HHTs" })));

  assert.strictEqual(socket.sent.length, 0);
  assert.ok(server.logger.reasons().includes("No data."));
});

test("a message with neither login nor target is dropped", (t) => {
  const server = withServer(t);

  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ data: { n: 3 } })));

  assert.ok(server.logger.reasons().includes("Either 'login' or 'target' must be specified."));
});

test("a login that is not connected is logged, not written to", (t) => {
  const server = withServer(t);

  server.mqtt.emit(
    "message",
    "NYX_WS_IN",
    Buffer.from(JSON.stringify({ login: "bob", target: "HHTs", data: {} }))
  );

  assert.ok(server.logger.reasons().some((line) => line.includes("not found on target")));
});

test("a login that is not connected globally is logged", (t) => {
  const server = withServer(t);

  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ login: "bob", data: {} })));

  assert.ok(server.logger.reasons().some((line) => line.includes("not found or not connected")));
});

test("a target with no client connected says so", (t) => {
  const server = withServer(t);

  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ target: "Console", data: {} })));

  assert.ok(server.logger.reasons().some((line) => line.includes("No client connected")));
});

test("a payload that is not JSON is logged, not thrown", (t) => {
  const server = withServer(t);

  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from("not json at all"));

  assert.ok(server.logger.reasons().includes("Unable to decode message"));
});

test("a token belonging to the claimed account authenticates the socket", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  server.authenticate("HHTs", socket);

  assert.deepStrictEqual(socket.closed, []);
  assert.strictEqual(socket.authenticated, true);
  assert.deepStrictEqual(socket.logins, ["alice@example.com", "alice"]);
});

test("a token of another account is refused", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");

  server.redis.store["nyx_tok_" + TOKEN] = JSON.stringify({ id: "bob@example.com" });
  socket.emit("message", JSON.stringify({ token: TOKEN, user: { user: "alice" } }));

  assert.deepStrictEqual(socket.closed, [[4401, "invalid token"]]);
  assert.notStrictEqual(socket.authenticated, true);
});

test("a store that answers with an error refuses the socket", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  const originalGet = server.redis.get.bind(server.redis);
  server.redis.get = (key, callback) => callback(new Error("redis down"), null);

  socket.emit("message", JSON.stringify({ token: TOKEN, user: { user: "alice" } }));

  assert.deepStrictEqual(socket.closed, [[4401, "authentication unavailable"]]);
  assert.ok(server.logger.reasons().some((line) => line.includes("Token lookup failed")));
  server.redis.get = originalGet;
});

test("a store that never answers lets the socket time out", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  server.redis.get = () => {}; // le magasin ne repond jamais

  server.captureTimers(() => {
    socket.emit("message", JSON.stringify({ token: TOKEN, user: { user: "alice" } }));
  });
  assert.deepStrictEqual(socket.closed, []);

  // Le delai d'authentification est le dernier pose par le handler.
  const timeout = server.lastTimeout();
  assert.strictEqual(timeout.delay, 2000);
  timeout.callback();

  assert.deepStrictEqual(socket.closed, [[4401, "authentication timed out"]]);
});

test("a login frame without a token is refused", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");

  socket.emit("message", JSON.stringify({ type: "login", user: { login: "alice" } }));

  assert.deepStrictEqual(socket.closed, [[4401, "authentication requires a token"]]);
});

test("an unauthenticated socket cannot publish into the broker", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");

  socket.emit("message", JSON.stringify({ temperature: 21 }));

  assert.deepStrictEqual(socket.closed, [[4401, "not authenticated"]]);
  assert.deepStrictEqual(server.mqtt.published.filter(([topic]) => topic === "HHTMessages"), []);
});

test("an authenticated socket publishes to its forward topic", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  server.authenticate("HHTs", socket);

  const payload = JSON.stringify({ temperature: 21 });
  socket.emit("message", payload);

  assert.deepStrictEqual(
    server.mqtt.published.filter(([topic]) => topic === "HHTMessages").map(([, body]) => body),
    [payload]
  );
});

test("a target that allows anonymous clients forwards without authentication", (t) => {
  const server = withServer(t);
  const socket = server.connect("Devices");

  const payload = JSON.stringify({ device: "sensor-1", temperature: 19 });
  socket.emit("message", payload);

  assert.deepStrictEqual(socket.closed, []);
  assert.deepStrictEqual(
    server.mqtt.published.filter(([topic]) => topic === "DeviceMessages").map(([, body]) => body),
    [payload]
  );
});

test("a target without a forward topic does not publish", (t) => {
  const server = withServer(t);
  const socket = server.connect("Console");
  server.authenticate("Console", socket);

  socket.emit("message", JSON.stringify({ anything: true }));

  assert.deepStrictEqual(server.mqtt.published.filter(([topic]) => topic !== "NYX_WS_INFO"), []);
});

test("the token never reaches the logs", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  server.authenticate("HHTs", socket);

  assert.ok(!server.logger.text().includes(TOKEN), "le jeton est en clair dans le journal");
});

test("a disconnect unregisters the login it held", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  server.authenticate("HHTs", socket);

  socket.emit("close");

  // Le login ne doit plus etre adressable: le message est journalise comme perdu.
  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ login: "alice", data: {} })));
  assert.ok(server.logger.reasons().some((line) => line.includes("not found or not connected")));
});

test("the life sign counts the connections and the logins", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  server.authenticate("HHTs", socket);
  server.mqtt.emit("message", "NYX_WS_IN", Buffer.from(JSON.stringify({ target: "HHTs", data: {} })));

  server.interval(0)(); // moduleLifeSign

  const signs = server.mqtt.bodies("NYX_MODULE_INFO");
  assert.strictEqual(signs.length, 1);
  const sign = signs[0];
  assert.strictEqual(sign.module, "WebSocketServer");
  assert.strictEqual(sign.connections, 1);
  assert.strictEqual(sign.messages, 1);
  assert.deepStrictEqual(sign.logins, ["alice@example.com", "alice"]);
  assert.deepStrictEqual(
    sign.clients.find((entry) => entry.name === "HHTs"),
    { name: "HHTs", port: 59999, clients: 1, logins: ["alice@example.com", "alice"] }
  );
  // Un serveur configure sans client s'annonce quand meme, a zero.
  assert.deepStrictEqual(
    sign.clients.find((entry) => entry.name === "Console"),
    { name: "Console", port: 59998, clients: 0, logins: [] }
  );
});

test("the heartbeat only writes lifesign frames to open clients", (t) => {
  const server = withServer(t);
  const open = server.connect("HHTs");
  const closed = server.connect("HHTs");
  closed.readyState = 3;
  const silent = server.connect("Quiet"); // `lifesign: false` dans la configuration

  server.interval(1)(); // checkWebSockets

  assert.deepStrictEqual(open.payloads(), [{ type: "lifesign" }]);
  assert.strictEqual(closed.sent.length, 0);
  assert.strictEqual(silent.sent.length, 0, "un serveur configure sans lifesign ne recoit rien");
});

test("SIGTERM closes the servers, the broker link and the store", (t) => {
  const server = withServer(t);
  const { server: webSocketServer } = server.target("HHTs");
  // `shutdown` finit par `process.exit(0)`: sans ce double, le processus de test mourrait ici.
  const originalExit = process.exit;
  process.exit = (code) => server.exits.push(code);
  t.after(() => {
    process.exit = originalExit;
  });

  server.captureTimers(() => process.emit("SIGTERM"));

  assert.strictEqual(webSocketServer.closed, true);
  assert.strictEqual(server.mqtt.ended, true);
  assert.strictEqual(server.redis.quits, 1);
  // L'arret differe de 500 ms, non bloque pour le conteneur.
  const exit = server.lastTimeout();
  assert.strictEqual(exit.delay, 500);
  exit.callback();
  assert.deepStrictEqual(server.exits, [0]);
});

test("SIGINT is handled like SIGTERM", (t) => {
  const server = withServer(t);

  process.emit("SIGINT");

  assert.strictEqual(server.mqtt.ended, true);
});

test("an unhandled rejection is logged", (t) => {
  const server = withServer(t);

  process.emit("unhandledRejection", "boom");

  assert.ok(server.logger.reasons().some((line) => line.includes("Unhandled rejection: boom")));
});

test("an uncaught exception leaves a trace and stops the process", (t) => {
  const server = withServer(t);
  const originalExit = process.exit;
  process.exit = (code) => server.exits.push(code);
  t.after(() => {
    process.exit = originalExit;
  });

  process.emit("uncaughtException", new Error("boom"));

  assert.ok(server.logger.reasons().some((line) => line.includes("Uncaught exception: Error: boom")));
  assert.deepStrictEqual(server.exits, [1]);
});

test("a socket error is logged without stopping the others", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");

  socket.emit("error", new Error("EPIPE"));

  assert.ok(server.logger.reasons().some((line) => line.includes("Socket error (HHTs): EPIPE")));
});

test("a server error is logged", (t) => {
  const server = withServer(t);
  const { server: webSocketServer } = server.target("HHTs");

  webSocketServer.emit("error", new Error("EADDRINUSE"));

  assert.ok(server.logger.reasons().some((line) => line.includes("WebSocket server HHTs: EADDRINUSE")));
});

test("the payload bound is set on every server", (t) => {
  const server = withServer(t);

  server.config.forEach((entry, index) => {
    assert.strictEqual(FakeServer.instances[index].options.maxPayload, 64 * 1024);
    assert.strictEqual(FakeServer.instances[index].options.port, entry.port);
  });
});

// --- Ce que le conteneur voit quand les choses vont mal ---------------------

test("a Redis outage is logged, not thrown", (t) => {
  const server = withServer(t);

  server.redis.emit("error", new Error("connection refused"));

  assert.ok(server.logger.reasons().includes("Redis: connection refused"));
});

test("a broker outage is logged, not thrown", (t) => {
  const server = withServer(t);

  server.mqtt.emit("error", new Error("mqtt down"));

  assert.ok(server.logger.reasons().includes("MQTT: mqtt down"));
});

test("a socket that refuses to close is terminated", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  socket.close = () => {
    throw new Error("already closed");
  };

  socket.emit("message", JSON.stringify({ type: "login", user: { login: "alice" } }));

  assert.strictEqual(socket.terminated, 1);
});

test("a store that answers after the deadline is ignored", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");
  let answer = null;
  server.redis.get = (key, callback) => {
    answer = callback; // le magasin repondra plus tard
  };

  server.captureTimers(() => {
    socket.emit("message", JSON.stringify({ token: TOKEN, user: { user: "alice" } }));
  });
  server.lastTimeout().callback(); // le delai expire d'abord
  assert.deepStrictEqual(socket.closed, [[4401, "authentication timed out"]]);

  // Puis le magasin repond: le socket ne doit pas etre authentifie apres coup.
  server.redis.store["nyx_tok_" + TOKEN] = JSON.stringify(ALICE);
  answer(null, JSON.stringify(ALICE));
  assert.notStrictEqual(socket.authenticated, true);
});

test("a deadline that fires after a prompt answer does nothing", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");

  server.captureTimers(() => server.authenticate("HHTs", socket));
  assert.strictEqual(socket.authenticated, true);

  server.lastTimeout().callback(); // le delai se referme sur une reponse deja arrivee

  assert.deepStrictEqual(socket.closed, []);
});

test("an unknown target is dropped even when a login is given", (t) => {
  const server = withServer(t);

  server.mqtt.emit(
    "message",
    "NYX_WS_IN",
    Buffer.from(JSON.stringify({ login: "alice", target: "Nope", data: {} }))
  );

  assert.ok(server.logger.reasons().includes("Unknown target."));
});

test("a payload that is not JSON on an unauthenticated socket is refused", (t) => {
  const server = withServer(t);
  const socket = server.connect("HHTs");

  socket.emit("message", "raw device reading");

  assert.deepStrictEqual(socket.closed, [[4401, "not authenticated"]]);
});

test("a store that refuses to close does not stop the shutdown", (t) => {
  const server = withServer(t);
  server.redis.quit = () => {
    throw new Error("already gone");
  };

  server.captureTimers(() => process.emit("SIGTERM"));

  assert.ok(server.logger.reasons().some((line) => line.includes("Redis close: already gone")));
  assert.strictEqual(server.mqtt.ended, true);
});
