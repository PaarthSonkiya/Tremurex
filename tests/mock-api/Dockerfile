# Demo-only image (docker compose --profile demo). Serves the controllable
# mock API so a first-time user can manufacture drift without a real upstream.
# Build context: tests/mock-api. The REST server (src/server.ts → mock-api.ts)
# has zero runtime deps, so a global tsx is all it needs.
FROM node:22-alpine
RUN npm install -g tsx@4
WORKDIR /app
# package.json carries "type": "module" so tsx treats the sources as ESM
# (server.ts uses top-level await). Its deps are not installed — the REST
# server has none; only the MCP entry (unused here) imports the SDK.
COPY package.json ./
COPY src ./src

ENV MOCK_API_PORT=5050 MOCK_API_HOST=0.0.0.0
EXPOSE 5050
CMD ["tsx", "src/server.ts"]
