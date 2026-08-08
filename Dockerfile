FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG CACHE_BUST=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# cache bust 1786166714
RUN npm run typecheck && ./node_modules/.bin/tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/cloud/db/migrations ./cloud/db/migrations
COPY --from=build /app/deploy/start.mjs ./deploy/start.mjs
COPY --from=build /app/deploy/smoke-runtime-layout.mjs ./deploy/smoke-runtime-layout.mjs
RUN node deploy/smoke-runtime-layout.mjs /app
RUN mkdir -p /data/cards && chown -R node:node /app /data/cards
USER node
CMD ["node", "deploy/start.mjs"]
