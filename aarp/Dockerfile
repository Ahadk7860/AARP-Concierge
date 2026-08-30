# AARP Concierge — HTTP bridge + Photon (Spectrum) iMessage loop.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY aarp/package.json aarp/package-lock.json ./aarp/
RUN cd aarp && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY aarp/src ./aarp/src
COPY aarp/data/benefits.json ./aarp/data/benefits.json
RUN mkdir -p /data/members && chown -R node:node /app /data
ENV AARP_MEMBERS_DIR=/data/members
USER node
EXPOSE 3055
CMD ["node", "aarp/src/server.js"]
