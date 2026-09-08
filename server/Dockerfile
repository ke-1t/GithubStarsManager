FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine

ARG OCI_SOURCE
ARG OCI_REVISION
ARG OCI_CREATED
RUN test -n "$OCI_SOURCE" && test -n "$OCI_REVISION" && test -n "$OCI_CREATED"
LABEL org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.created=$OCI_CREATED

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
RUN mkdir -p data && chown -R node:node /app
USER node
VOLUME /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(async (response) => { if (!response.ok) process.exit(1); const body = await response.json(); if (body.status !== 'ok') process.exit(1); }).catch(() => process.exit(1))"]
CMD ["node", "dist/index.js"]
