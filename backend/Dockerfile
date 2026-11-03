FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/contracts/package.json ./shared/contracts/package.json
COPY backend/package.json ./backend/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/browser-extension/package.json ./apps/browser-extension/package.json
RUN npm ci --include=dev

COPY shared/contracts ./shared/contracts
COPY backend ./backend
RUN npm run db:generate --workspace @digitalpulse/backend
RUN mkdir -p /app/backend/storage && chown -R node:node /app/backend/storage

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 3001
CMD ["sh", "-c", "npm run db:deploy --workspace @digitalpulse/backend && npm run start:backend"]
