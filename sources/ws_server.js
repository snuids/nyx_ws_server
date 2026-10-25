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
var VERSION = "1.2.2";
var messages = 0;

logger.info("Starting WS Server:" + VERSION);
var ws_config = JSON.parse(process.env.CONFIG.replace(/'/g, '"'));
logger.info("CONFIG");
logger.info(ws_config);
/*
  config example
/ - "CONFIG=[{ 'name': 'HHTs', 'port': 59999, 'lifesign': false, 'forward_topic': 'HHTMessages' }]"
*/
var clientsHT = {};
var globalLogins = {}; // Global map: login -> { target: targetName, ws: WebSocket }

function loginKeys(user) {
  if (!user) {
    return [];
  }
  var keys = [];
  ["id", "user", "login"].forEach(function (field) {
    var value = user[field];
    if (value && keys.indexOf(value) === -1) {
      keys.push(value);
    }
  });
  return keys;
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
        onews = clientsHT[newmes.target];
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
      onews = clientsHT[newmes.target];
      if (onews.wss.clients.size > 0) {
        onews.wss.clients.forEach(function (onecli) {
          onecli.send(JSON.stringify({ type: type, data: newmes.data }));
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

setInterval(moduleLifeSign, 5000);

ws_config.forEach(function (onews) {
  logger.info(onews);
  onews.wss = new WebSocket.Server({ port: onews.port });
  onews.wss.on("connection", (ws, req) => {
    logger.info(">> New Client. for " + onews.name + " port:" + onews.port);
    logger.info(">> IP:" + req.connection.remoteAddress);
    mqttclient.publish(
      "NYX_WS_INFO",
      JSON.stringify({ Name: onews.name, Port: onews.port, IP: req.connection.remoteAddress })
    );
    
    ws.on("message", (message) => {
      logger.info(`Received message => ${message}`);
      try {
        let msgData = JSON.parse(message);
        
        // Handle UI authentication message format
        const keys = loginKeys(msgData.user);
        if (msgData.token && keys.length > 0) {
          registerLogin(onews, ws, keys);
          ws.userInfo = msgData.user; // Store full user info (language, privileges, etc.)
          logger.info(`Client authenticated as: ${ws.login} (aliases: ${keys.join(", ")}, language: ${msgData.user.language})`);
          // ws.send(JSON.stringify({ 
          //   type: "auth_success", 
          //   user: username,
          //   authenticated: true
          // }));
          return;
        }
        
        // Handle simple login message (backward compatibility)
        if (msgData.type === "login" && msgData.login) {
          registerLogin(onews, ws, [msgData.login]);
          logger.info(`Client logged in as: ${msgData.login}`);
          ws.send(JSON.stringify({ type: "login_success", login: msgData.login }));
          return;
        }
      } catch (e) {
        // If not JSON or no type/login, continue with forwarding
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
        onecli.send(JSON.stringify({ type: "lifesign" }));
      });
    }
  });
}

setInterval(checkWebSockets, 5000);
