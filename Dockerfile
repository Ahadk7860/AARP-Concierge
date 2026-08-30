# AARP Concierge bridge — zero-dependency runtime, so no npm install at all.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY aarp/src ./aarp/src
COPY aarp/data/benefits.json ./aarp/data/benefits.json
RUN mkdir -p /data/members && chown -R node:node /app /data
ENV AARP_MEMBERS_DIR=/data/members
USER node
EXPOSE 3055
CMD ["node", "aarp/src/server.js"]
