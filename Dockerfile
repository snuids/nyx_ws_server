FROM node:11.12-slim 
RUN apt-get update
RUN apt-get install -y vim

WORKDIR /etc/opt
COPY ./sources/package.json /etc/opt/package.json
RUN cd /etc/opt/
RUN npm i
COPY ./sources/ws_server.js /etc/opt/ws_server.js
RUN ls -l /etc/opt/
CMD node /etc/opt/ws_server.js
