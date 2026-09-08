# syntax=docker/dockerfile:1
# `dist` only contains static assets, so build it once on the native builder.
# The final nginx stage remains target-platform aware for amd64 and arm64.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

ARG OCI_SOURCE
ARG OCI_REVISION
ARG OCI_CREATED
RUN test -n "$OCI_SOURCE" && test -n "$OCI_REVISION" && test -n "$OCI_CREATED"
LABEL org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.created=$OCI_CREATED

# Remove default nginx config that conflicts with ours
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy built files from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Copy custom nginx configuration template (rendered at startup with BACKEND_HOST)
COPY nginx.conf.template /etc/nginx/nginx.conf.template

# Expose port
EXPOSE 80

# Render the nginx config (substituting BACKEND_HOST and RESOLVER) and start nginx
CMD ["sh", "-c", "export BACKEND_HOST=${BACKEND_HOST:-backend:3000}; export RESOLVER=${RESOLVER:-127.0.0.11}; envsubst '${BACKEND_HOST} ${RESOLVER}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf && nginx -g 'daemon off;'"]
