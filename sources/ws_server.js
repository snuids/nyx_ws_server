var log4js = require("log4js");
var logger = log4js.getLogger();
logger.level = "info";

log4js.configure({
  appenders: {
    filelog: { type: "dateFile", filename: "./logs/ws_server.log" },
    everything: { type: "stdout" },
  },
  categories: { default: { appenders: ["filelog", "everything"], level: "info" } },
});

const WebSocket = require("ws");
var mqtt = require("mqtt");
var redis = require("redis");
const auth = require("./lib/auth");
var VERSION = "1.2.5";
var messages = 0;

logger.info("Starting WS Server:" + VERSION);
var ws_config = JSON.parse(process.env.CONFIG.replace(/'/g, '"'));
logger.info("CONFIG");
logger.info(ws_config);

// The token store is the authority on who a socket is: the API writes `nyx_tok_<token>` on login,
// with a 24 h TTL, and every other component (the nginx guard included) reads it from there.
var redisClient = redis.createClient({
  host: process.env.REDIS_IP || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  // Without this, a command issued while Redis is down waits in a queue and its callback never
  // fires: an authentication check must answer, not hang.
  enable_offline_queue: false,
});
redisClient.on("error", function (error) {
  logger.error("Redis: " + error.message);
});
/*
  config example
/ - "CONFIG=[{ 'name': 'HHTs', 'port': 59999, 'lifesign': false, 'forward_topic': 'HHTMessages' }]"
*/
var clientsHT = {};
var globalLogins = {}; // Global map: login -> { target: targetName, ws: WebSocket }

function loginKeys(user) {
  return auth.loginKeys(user);
}

function registerLogin(onews, ws, keys) {
  keys.forEach(function (key) {
    onews.clientLogins[key] = ws;
    globalLogins[key] = { target: onews.name, ws: ws };
  });
  ws.logins = keys;
  ws.login = keys[0];
  ws.targetName = onews.name;
}

function unregisterLogin(onews, ws) {
  (ws.logins || []).forEach(function (key) {
    if (onews.clientLogins[key] === ws) {
      delete onews.clientLogins[key];
    }
    if (globalLogins[key] && globalLogins[key].ws === ws) {
      delete globalLogins[key];
    }
  });
}

function refuse(ws, reason) {
  logger.warn("Closing socket: " + reason);
  try {
    ws.close(4401, reason);
  } catch (error) {
    ws.terminate();
  }
}

// The token must exist in the store *and* belong to the account being claimed. Only the first
// point used to be missing, which made every login a self-declaration.
function authenticate(onews, ws, msgData, keys) {
  var answered = false;
  // A store that does not answer must not leave a socket waiting in an undefined state.
  var timer = setTimeout(function () {
    if (answered) {
      return;
    }
    answered = true;
    refuse(ws, "authentication timed out");
  }, 2000);

  redisClient.get(auth.tokenKey(msgData.token), function (error, stored) {
    if (answered) {
      return;
    }
    answered = true;
    clearTimeout(timer);
    if (error) {
      logger.error("Token lookup failed: " + error.message);
      refuse(ws, "authentication unavailable");
      return;
    }
    if (!stored || !auth.identityMatches(stored, keys)) {
      logger.warn("Rejected token claiming " + keys.join(","));
      refuse(ws, "invalid token");
      return;
    }
    registerLogin(onews, ws, keys);
    ws.authenticated = true;
    ws.userInfo = msgData.user;
    logger.info(`Client authenticated as: ${ws.login} (aliases: ${keys.join(",")})`);
  });
}

ws_config.forEach(function (onews) {
  clientsHT[onews.name] = onews;
  // Initialize login tracking for each WebSocket server
  onews.clientLogins = {}; // Map: login -> WebSocket connection
});

logger.info(clientsHT);

var mqttclient = mqtt.connect({
  host: process.env.AMQC_URL,
  port: process.env.AMQC_PORT,
  username: process.env.AMQC_LOGIN,
  password: process.env.AMQC_PASSWORD,
});

logger.info("Starting MQTT:" + process.env.AMQC_URL + ". Listening to:" + process.env.IN_TOPIC);

mqttclient.on("error", function (error) {
  logger.error("MQTT: " + error.message);
});

mqttclient.on("connect", function () {
  mqttclient.subscribe(process.env.IN_TOPIC, function (err) {
    logger.info("MQTT Connected");
  });
});

mqttclient.on("message", function (topic, message) {
  // message is Buffer
  messages++;
  logger.info("Received:" + message.toString());
  try {
    var newmes = JSON.parse(message.toString());
    let type = "message";

    if (newmes.type == undefined) {
      logger.info("Type not specified. Using 'message' as default.");
    } else {
      type = newmes.type;
    }

    if (newmes.data == undefined) {
      logger.error("No data.");
      return;
    }

    // If login is specified (with or without target)
    if (newmes.login != undefined) {
      // Check if target is also specified
      if (newmes.target != undefined) {
        // Use specified target
        if (clientsHT[newmes.target] == undefined) {
          logger.error("Unknown target.");
          return;
        }
        let onews = clientsHT[newmes.target];
        let targetClient = onews.clientLogins[newmes.login];
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          targetClient.send(JSON.stringify({ type: type, data: newmes.data }));
          logger.info("Message sent to login: " + newmes.login + " on target: " + newmes.target);
        } else {
          logger.error("Login '" + newmes.login + "' not found on target '" + newmes.target + "'.");
        }
      } else {
        // No target specified - search globally
        let loginInfo = globalLogins[newmes.login];
        if (loginInfo && loginInfo.ws.readyState === WebSocket.OPEN) {
          loginInfo.ws.send(JSON.stringify({ type: type, data: newmes.data }));
          logger.info("Message sent to login: " + newmes.login + " (auto-found on target: " + loginInfo.target + ")");
        } else {
          logger.error("Login '" + newmes.login + "' not found or not connected.");
        }
      }
    } else if (newmes.target != undefined) {
      // Only target specified - broadcast to all clients on that target
      if (clientsHT[newmes.target] == undefined) {
        logger.error("Unknown target.");
        return;
      }
      let onews = clientsHT[newmes.target];
      if (onews.wss.clients.size > 0) {
        onews.wss.clients.forEach(function (onecli) {
          // Only OPEN sockets: a closed one silently buffers the send (and grows `bufferedAmount`)
          // instead of reporting anything, so a broadcast would look delivered and be lost.
          if (onecli.readyState === WebSocket.OPEN) {
            onecli.send(JSON.stringify({ type: type, data: newmes.data }));
          }
        });
        logger.info("Message broadcast to all clients on target: " + newmes.target);
      } else {
        logger.error("No client connected to target: " + newmes.target);
      }
    } else {
      logger.error("Either 'login' or 'target' must be specified.");
      return;
    }
  } catch {
    logger.error("Unable to decode message");
  }
});

function moduleLifeSign() {
  var clients = [];
  var connections = 0;
  var allLogins = []; // List of all connected logins across all targets
  
  ws_config.forEach(function (onews) {
    if (onews.wss != undefined) {
      if (onews.wss.clients != undefined) {
        connections += onews.wss.clients.size;
        
        // Get list of logins for this target
        let targetLogins = Object.keys(onews.clientLogins || {});
        allLogins = allLogins.concat(targetLogins);
        
        clients.push({ 
          name: onews.name, 
          port: onews.port, 
          clients: +onews.wss.clients.size,
          logins: targetLogins
        });
      } else {
        clients.push({ name: onews.name, port: onews.port, clients: 0, logins: [] });
      }
    }
  });
  var lifesign = {
    error: "OK",
    type: "lifesign",
    module: "WebSocketServer",
    version: VERSION,
    alive: 1,
    errors: 0,
    internalerrors: 0,
    heartbeaterrors: 0,
    eventtype: "lifesign",
    messages: messages,
    received: {},
    amqclientversion: VERSION,
    starttimets: new Date().getTime(),
    starttime: new Date(),
    connections: connections,
    platform: process.platform,
    icon: "socks",
    clients: clients,
    logins: allLogins, // All connected logins
  };

  mqttclient.publish("NYX_MODULE_INFO", JSON.stringify(lifesign));
}

var lifesignTimer = setInterval(moduleLifeSign, 5000);
var heartbeatTimer = setInterval(checkWebSockets, 5000);

// A container stop sends SIGTERM: closing the sockets and the broker link lets the clients see a
// real disconnect instead of a dropped connection, and stops emitting heartbeats nobody reads.
function shutdown(signal) {
  logger.info("Stopping on " + signal);
  clearInterval(lifesignTimer);
  clearInterval(heartbeatTimer);
  ws_config.forEach(function (onews) {
    if (onews.wss) {
      onews.wss.close();
    }
  });
  mqttclient.end();
  try {
    redisClient.quit();
  } catch (error) {
    logger.warn("Redis close: " + error.message);
  }
  setTimeout(function () {
    process.exit(0);
  }, 500).unref();
}

process.on("SIGTERM", function () {
  shutdown("SIGTERM");
});
process.on("SIGINT", function () {
  shutdown("SIGINT");
});
process.on("unhandledRejection", function (reason) {
  logger.error("Unhandled rejection: " + reason);
});
process.on("uncaughtException", function (error) {
  // Leave a trace and let the supervisor restart a process in an unknown state.
  logger.error("Uncaught exception: " + (error && error.stack ? error.stack : error));
  process.exit(1);
});

ws_config.forEach(function (onews) {
  logger.info(onews);
  // `maxPayload` bounds what one client can make the process parse and relay: the default is
  // 100 MiB, and the body is published to the broker as it arrives.
  onews.wss = new WebSocket.Server({ port: onews.port, maxPayload: 64 * 1024 });
  // An emitter error with no listener terminates the process: a single malformed frame would have
  // been enough to stop every client from receiving anything.
  onews.wss.on("error", function (error) {
    logger.error("WebSocket server " + onews.name + ": " + error.message);
  });
  onews.wss.on("connection", (ws, req) => {
    ws.on("error", function (error) {
      logger.error("Socket error (" + onews.name + "): " + error.message);
    });
    logger.info(">> New Client. for " + onews.name + " port:" + onews.port);
    logger.info(">> IP:" + req.connection.remoteAddress);
    mqttclient.publish(
      "NYX_WS_INFO",
      JSON.stringify({ Name: onews.name, Port: onews.port, IP: req.connection.remoteAddress })
    );
    
    ws.on("message", (message) => {
      // The body carries the session token when a client authenticates: the raw string must never
      // reach the log file, where it stays replayable for the life of the token.
      logger.info(`Received message => ${auth.redact(message)}`);
      try {
        let msgData = JSON.parse(message);

        // UI authentication: a token plus the account it is supposed to belong to.
        const keys = loginKeys(msgData.user);
        if (msgData.token && keys.length > 0) {
          authenticate(onews, ws, msgData, keys);
          return;
        }

        // The token-less login path is gone: it registered a login on the client's word, which
        // let anyone take over another client's traffic.
        if (msgData.type === "login") {
          refuse(ws, "authentication requires a token");
          return;
        }
      } catch (e) {
        // Not a JSON control frame: a payload to forward, if this socket is allowed to.
      }

      // Publishing into the broker is publishing on the platform's internal bus. A target that
      // really relays device traffic says so explicitly in its configuration.
      if (!ws.authenticated && onews.allow_anonymous !== true) {
        refuse(ws, "not authenticated");
        return;
      }

      if ("forward_topic" in onews) {
        logger.info(`Forwarding to topic => ${onews["forward_topic"]}`);
        mqttclient.publish(onews["forward_topic"], message);
      }
    });
    
    // Clean up login mapping when client disconnects
    ws.on("close", () => {
      if (ws.login) {
        logger.info(`Client disconnected: ${ws.login}`);
        unregisterLogin(onews, ws);
      }
    });
  });
});

function checkWebSockets() {
  ws_config.forEach(function (onews) {
    logger.info("Name:" + onews.name + " clients:" + onews.wss.clients.size);
    if (onews.wss.clients.size > 0 && (("lifesign" in onews && onews["lifesign"] == true) || !("lifesign" in onews))) {
      onews.wss.clients.forEach(function (onecli) {
        if (onecli.readyState === WebSocket.OPEN) {
          onecli.send(JSON.stringify({ type: "lifesign" }));
        }
      });
    }
  });
}