FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3180
COPY package.json package-lock.json ./
COPY --chown=node:node dist/runtime-node_modules ./node_modules
COPY --chown=node:node dist/server ./dist/server
COPY --chown=node:node dist/web ./dist/web
COPY --chown=node:node persona ./persona
USER node
EXPOSE 3180
CMD ["node", "dist/server/index.js"]
