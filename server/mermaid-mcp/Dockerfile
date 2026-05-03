# claude-mermaid を mcp-proxy で stdio→HTTP 化
# upstream: https://github.com/veelenga/claude-mermaid

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget chromium \
      fonts-liberation fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# claude-mermaid は puppeteer config を渡す経路を持たないため、root 実行時に必須の
# --no-sandbox を chromium ラッパで強制注入する (コンテナ内なので sandbox 緩和は許容)。
RUN mv /usr/bin/chromium /usr/bin/chromium-real \
    && printf '#!/bin/sh\nexec /usr/bin/chromium-real --no-sandbox --disable-dev-shm-usage "$@"\n' > /usr/bin/chromium \
    && chmod +x /usr/bin/chromium

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install -g claude-mermaid mcp-proxy

ENV MCP_PROXY_PORT=8003
ENV NODE_ENV=production

EXPOSE 8003
CMD ["sh", "-c", "mcp-proxy --port ${MCP_PROXY_PORT} --host 0.0.0.0 -- claude-mermaid"]
