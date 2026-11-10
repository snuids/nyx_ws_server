# Node 22 LTS. The image ran `mhart/alpine-node:13.12.0`: Node 13 left support in June 2020, so no
# security patch has reached this service since — and `node --test`, which the suite now uses,
# does not exist there. The server is CommonJS and talks to `redis` through the 3.x callback API,
# none of which Node 22 changes; the tests run on 22 in CI, and this image is built from the same
# sources.
FROM node:22-alpine

WORKDIR /etc/opt
COPY ./sources/package.json /etc/opt/package.json
RUN npm i
COPY ./sources/ws_server.js /etc/opt/ws_server.js
COPY ./sources/lib /etc/opt/lib
CMD while true; do node ws_server; sleep 5; done
