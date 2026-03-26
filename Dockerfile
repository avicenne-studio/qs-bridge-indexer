FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

RUN mkdir -p /data

ENV NODE_URL=http://qubic-testnet:41841
ENV DB_PATH=/data/indexer.db
ENV HTTP_PORT=3002
ENV POLL_INTERVAL_MS=500
ENV QSB_CONTRACT_INDEX=26

EXPOSE 3002

CMD ["node", "dist/index.js"]
