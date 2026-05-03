# openai-gen-image-mcp を mcp-proxy で stdio→HTTP 化
# upstream: https://github.com/kazyam53/openai_gen_image_mcp (Phase 0-1 で確定)

FROM python:3.13-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN uv tool install git+https://github.com/kazyam53/openai_gen_image_mcp.git
RUN npm install -g mcp-proxy

# sitecustomize.py で tempfile.mkdtemp の mode を 0o755 に補正
# (image-hub-app コンテナ uid 1000 から ro 参照するため、root 0o700 だと EACCES)
COPY sitecustomize.py /opt/sitecustomize/sitecustomize.py
ENV PYTHONPATH=/opt/sitecustomize

ENV MCP_PROXY_PORT=8001
EXPOSE 8001
CMD ["sh", "-c", "mcp-proxy --port ${MCP_PROXY_PORT} --host 0.0.0.0 -- /root/.local/bin/openai-gen-image-mcp"]
