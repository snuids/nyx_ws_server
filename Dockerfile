FROM mhart/alpine-node:13.12.0

WORKDIR /etc/opt
COPY ./sources/package.json /etc/opt/package.json
RUN npm i
COPY ./sources/ws_server.js /etc/opt/ws_server.js
CMD while true; do node ws_server; sleep 5; done
