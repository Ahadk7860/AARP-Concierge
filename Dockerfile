# AARP Concierge — HTTP bridge + Photon (Spectrum) iMessage loop.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY aarp/package.json aarp/package-lock.json ./aarp/
RUN cd aarp && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY aarp/src ./aarp/src
COPY aarp/data/benefits.json ./aarp/data/benefits.json
COPY aarp/builder ./aarp/builder
# Railway volumes mount root-owned at runtime, so the process stays root and
# fixes ownership of /data at boot (prototype tier; single-purpose container).
ENV AARP_MEMBERS_DIR=/data/members
EXPOSE 3055
CMD ["node", "aarp/src/server.js"]
