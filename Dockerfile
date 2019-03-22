FROM node:7.7
RUN apt-get update
RUN apt-get install -y vim
COPY ./sources/ws_server.js /etc/opt/ws_server.js
RUN ls -l /etc/opt/
RUN npm -i
CMD node /etc/opt/ws_server.js
