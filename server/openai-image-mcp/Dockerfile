# openai-image-mcp service (HermesAgent / X Grok Imagine 経由で画像生成する MCP)
#
# upstream は server.py 内で HERMES_MCP_URL に JSON-RPC で tools/call generate_image
# を投げる薄いラッパ。返ってきた imgen.x.ai の URL から画像を DL し、
# /var/lib/openai-image-tmp/openai_gen_image_*/generated_*.{png,jpg,webp} に保存する。
# image-hub-app の intercept.ts がそのパスを検知して /files/<id> に昇格。
#
# service 名と volume 名 (openai-image / openai-image-tmp) は intercept.ts の
# REWRITE_RULES key と path pattern に紐付いているので互換維持のため変更しない。

FROM python:3.13-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir 'mcp[cli]>=1.19.0' 'httpx>=0.27'
RUN npm install -g mcp-proxy

COPY server.py /opt/xai-image-mcp/server.py

ENV PYTHONUNBUFFERED=1
ENV MCP_PROXY_PORT=8001
EXPOSE 8001
CMD ["sh", "-c", "mcp-proxy --port ${MCP_PROXY_PORT} --host 0.0.0.0 -- python /opt/xai-image-mcp/server.py"]
