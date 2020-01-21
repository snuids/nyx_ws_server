var log4js = require('log4js');
var logger = log4js.getLogger();
logger.level = 'info';

log4js.configure({
  appenders: {
    filelog: { type: 'file', filename: './logs/ws_server.log', maxLogSize: 10485760, backups: 5, compress: true },
    everything: { type: 'stdout' },
  },
  categories: { default: { appenders: ['filelog', 'everything'], level: 'info' } }
});

const WebSocket = require('ws')
var mqtt = require('mqtt')
var VERSION = "1.0.4"
var messages = 0

logger.info("Starting WS Server:"+VERSION)
var ws_config = JSON.parse(process.env.CONFIG.replace(/'/g,"\""))
logger.info("CONFIG")
logger.info(ws_config)
/*
  config example
/ - "CONFIG=[{ 'name': 'HHTs', 'port': 59999, 'lifesign': false }]"
*/
var clientsHT = {}
ws_config.forEach(function (onews) {

  clientsHT[onews.name] = onews;
});

logger.info(clientsHT);

var mqttclient = mqtt.connect({
  host: process.env.AMQC_URL,
  port: process.env.AMQC_PORT,
  username: process.env.AMQC_LOGIN,
  password: process.env.AMQC_PASSWORD
})

logger.info("Starting MQTT:" + process.env.AMQC_URL + ". Listening to:" + process.env.IN_TOPIC)

mqttclient.on('connect', function () {
  mqttclient.subscribe(process.env.IN_TOPIC, function (err) {
    logger.info("MQTT Connected")
  })
})

mqttclient.on('message', function (topic, message) {
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

    if (newmes.target == undefined) {
      logger.info("Target not specified.");
      return;
    }
    if (newmes.data == undefined) {
      logger.error("No data.");
      return;
    }
    if (clientsHT[newmes.target] == undefined) {
      logger.error("Unknown target.");
      return;
    }

    onews = clientsHT[newmes.target];
    if (onews.wss.clients.size > 0) {
      onews.wss.clients.forEach(function (onecli) {
        onecli.send(JSON.stringify({ "type": type, "data": newmes.data }));
      });
    }
    else {
      logger.error("No client connected.")
    }
  }
  catch
  {
    logger.error("Unable to decode message");
  }
})

function moduleLifeSign() {
  var clients = [];
  var connections = 0;
  ws_config.forEach(function (onews) {
    if (onews.wss != undefined) {
      if (onews.wss.clients != undefined) {
        connections += onews.wss.clients.size;
        clients.push({ "name": onews.name, "port": onews.port, "clients": +onews.wss.clients.size });
      }
      else {
        clients.push({ "name": onews.name, "port": onews.port, "clients": 0 });
      }
    }
  });
  var lifesign = {
    "error": "OK", "type": "lifesign", "module": "WebSocketServer", "version": VERSION, "alive": 1, "errors": 0, "internalerrors": 0, "heartbeaterrors": 0, "eventtype": "lifesign"
    , "messages": messages, "received": {}, "amqclientversion": "1.0.0", "starttimets": new Date().getTime(), "starttime": new Date(), "connections": connections, "platform": process.platform
    , "icon": "socks","clients":clients
  };

  mqttclient.publish('NYX_MODULE_INFO', JSON.stringify(lifesign));
}

setInterval(moduleLifeSign, 5000);

ws_config.forEach(function (onews) {
  logger.info(onews);
  onews.wss = new WebSocket.Server({ port: onews.port })
  onews.wss.on('connection', (ws,req) => {
    logger.info(">> New Client. for "+onews.name+" port:"+onews.port)
    logger.info(">> IP:"+req.connection.remoteAddress)
    mqttclient.publish('NYX_WS_INFO', JSON.stringify({"Name":onews.name,"Port":onews.port,"IP":req.connection.remoteAddress}));
    onews.wss.on('message', message => {
      logger.info(`Received message => ${message}`)
    })
  })
});

function checkWebSockets() {
  ws_config.forEach(function (onews) {
    logger.info("Name:" + onews.name + " clients:" + onews.wss.clients.size);
    if (onews.wss.clients.size > 0 && (('lifesign' in onews && onews['lifesign'] == true) || !('lifesign' in onews))) {      
      onews.wss.clients.forEach(function (onecli) {
        onecli.send(JSON.stringify({ "type": "lifesign" }));
      });

    }

  });
}

setInterval(checkWebSockets, 5000);



