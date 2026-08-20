FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY web-api/package.json web-api/package.json
RUN pnpm install --frozen-lockfile --filter @buzz/web-api...
COPY web-api web-api
RUN pnpm --filter @buzz/web-api build

FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/web-api/package.json web-api/package.json
COPY --from=build /app/web-api/dist web-api/dist
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/web-api/node_modules web-api/node_modules
CMD ["node", "web-api/dist/server.js"]
