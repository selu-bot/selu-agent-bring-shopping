FROM node:22-slim

ENV NODE_ENV=production
ARG BRING_MCP_NPM_VERSION=latest

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev && npm cache clean --force

RUN npm install -g "bring-mcp@${BRING_MCP_NPM_VERSION}" && npm cache clean --force

COPY capability.proto .
COPY server.js .

USER node

EXPOSE 50051

CMD ["node", "server.js"]
