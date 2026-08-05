FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && ./node_modules/.bin/tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/cloud/db/migrations ./cloud/db/migrations
COPY --from=build /app/deploy/start.mjs ./deploy/start.mjs
RUN mkdir -p /data/cards && chown -R node:node /app /data/cards
USER node
CMD ["node", "deploy/start.mjs"]
