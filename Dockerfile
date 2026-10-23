FROM node:22-slim
WORKDIR /app

# Dependências primeiro (aproveita o cache de camadas do Docker)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Código da aplicação
COPY server.mjs ./
COPY public ./public

# Pasta usada só para a chave local de desenvolvimento; em produção a chave vem de PEGASUS_MESSAGE_KEY
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PEGASUS_DATA_DIR=/data

# Variáveis exigidas em produção: DATABASE_URL e PEGASUS_MESSAGE_KEY (64 hex).
# Atrás de proxy (Render): PEGASUS_TRUST_PROXY=1

EXPOSE 3000
USER node
CMD ["node", "server.mjs"]
