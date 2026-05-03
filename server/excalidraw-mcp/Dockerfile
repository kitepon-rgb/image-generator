# mcp-excalidraw-server (npm) を mcp-proxy で stdio→HTTP 化
# upstream: https://github.com/yctimlin/mcp_excalidraw

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/*

RUN npm install -g mcp-excalidraw-server mcp-proxy

ENV MCP_PROXY_PORT=8002
ENV NODE_ENV=production

EXPOSE 8002
CMD ["sh", "-c", "mcp-proxy --port ${MCP_PROXY_PORT} --host 0.0.0.0 -- mcp-excalidraw-server"]
