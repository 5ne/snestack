# Stage 1: Build the Vite + React Web UI
FROM node:22-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# Stage 2: Build the TypeScript CLI & HTTP server
FROM node:22-slim AS node-build
WORKDIR /app/node
COPY node/package*.json ./
RUN npm install
COPY node/ ./
RUN npm run build && npm prune --omit=dev

# Stage 3: Lean runtime image (serves both /api/* and built Web UI on $PORT)
FROM node:22-slim
WORKDIR /app/node
ENV NODE_ENV=production
COPY --from=node-build /app/node/package*.json ./
COPY --from=node-build /app/node/node_modules ./node_modules
COPY --from=node-build /app/node/dist ./dist
COPY --from=node-build /app/node/src ./src
COPY --from=web-build /app/web/dist /app/web/dist

EXPOSE 4700
CMD ["node", "dist/cli.js", "serve"]
