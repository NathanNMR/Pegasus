FROM node:22-slim
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 PEGASUS_DATA_DIR=/data
# Exigidos em produção: PEGASUS_MESSAGE_KEY (64 hex). Atrás de proxy: PEGASUS_TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.mjs"]
