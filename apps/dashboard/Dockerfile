FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/contracts/package.json ./shared/contracts/package.json
COPY backend/package.json ./backend/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/browser-extension/package.json ./apps/browser-extension/package.json
RUN npm ci --include=dev

COPY shared/contracts ./shared/contracts
COPY apps/dashboard ./apps/dashboard
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build --workspace @digitalpulse/dashboard

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/dashboard/dist /srv
EXPOSE 80 443
