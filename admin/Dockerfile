# syntax=docker/dockerfile:1
# Build context: repository root (needs admin/, api/openapi.yaml and deploy/nginx/admin.conf).
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app
COPY api/openapi.yaml api/openapi.yaml
COPY admin/package.json admin/package-lock.json admin/
RUN cd admin && npm ci --no-audit --no-fund
COPY admin admin
ARG PUBLIC_API_URL=""
ARG PUBLIC_CLIENT_URL=""
ENV PUBLIC_API_URL=$PUBLIC_API_URL PUBLIC_CLIENT_URL=$PUBLIC_CLIENT_URL
RUN cd admin && npm run check:api && npm run build
# Put the API origin into the CSP connect-src (http→ws, https→wss for the live stream).
COPY deploy/nginx/admin.conf /tmp/admin.conf
RUN api="$(echo "$PUBLIC_API_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"; \
    if [ -n "$api" ]; then ws="$(echo "$api" | sed -E 's#^http#ws#')"; src="'self' $api $ws"; else src="'self'"; fi; \
    sed "s#__CONNECT_SRC__#$src#" /tmp/admin.conf > /tmp/default.conf

FROM nginxinc/nginx-unprivileged:alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
COPY --from=build /tmp/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/admin/build /usr/share/nginx/html/admin
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/admin/ >/dev/null || exit 1
