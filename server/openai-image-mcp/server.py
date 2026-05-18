"""xai-image-mcp — X (Grok Imagine) 画像生成を HermesAgent 経由で叩く MCP server.

OpenAI 課金から脱却するため、旧 upstream (kazyam53/openai_gen_image_mcp) を置換。
出力 path 形式 (/var/lib/openai-image-tmp/openai_gen_image_*/generated_*.{ext}) は
image-hub-app の intercept.ts (REWRITE_RULES['openai-image']) に拾わせるため
そのまま維持する。service 名・MCP 名・volume 名も互換のため `openai-image` を
保持しているが、実体の billing path は SuperGrok/Premium Plus 経由で課金ゼロ。
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent


def _require_env(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise SystemExit(f"FATAL: required env var {key!r} is not set")
    return v


mcp = FastMCP("openai-image")

_HERMES_URL = _require_env("HERMES_MCP_URL")
_HERMES_BEARER = _require_env("HERMES_BEARER_TOKEN")
_TMPDIR = os.environ.get("TMPDIR", "/var/lib/openai-image-tmp")

# imgen.x.ai 配下のみ image download を許可。Hermes 経由とはいえ URL は外部入力で、
# Docker 内部ネットワーク (image-hub-app 等) や file:// 系の SSRF を防ぐ。
_ALLOWED_IMAGE_HOST_SUFFIX = ".x.ai"

_EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
}


def _validate_image_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise RuntimeError(
            f"hermes: image url scheme must be https, got {parsed.scheme!r}"
        )
    host = parsed.hostname or ""
    if not host.endswith(_ALLOWED_IMAGE_HOST_SUFFIX):
        raise RuntimeError(
            f"hermes: image url host {host!r} not in allowlist (*{_ALLOWED_IMAGE_HOST_SUFFIX})"
        )


async def _call_hermes_generate_image(
    prompt: str,
    aspect_ratio: str,
    resolution: str,
    quality: bool,
) -> dict[str, Any]:
    # 各 tool call は独立した AsyncClient → 独立した接続なので、SSE stream 間の
    # id 衝突は発生しない。固定 1 で十分。
    rpc_id = 1
    payload = {
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": "tools/call",
        "params": {
            "name": "generate_image",
            "arguments": {
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "resolution": resolution,
                "quality": quality,
            },
        },
    }
    headers = {
        "Authorization": f"Bearer {_HERMES_BEARER}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(_HERMES_URL, json=payload, headers=headers)
        resp.raise_for_status()
        ctype = resp.headers.get("content-type", "")
        body = resp.text
    if "text/event-stream" in ctype:
        for block in body.split("\n\n"):
            data_lines = [
                line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")
            ]
            if not data_lines:
                continue
            try:
                envelope = json.loads("\n".join(data_lines))
            except json.JSONDecodeError:
                continue
            if envelope.get("id") == rpc_id:
                return envelope
        raise RuntimeError("hermes: no matching JSON-RPC response in SSE stream")
    return json.loads(body)


def _extract_image_payload(envelope: dict[str, Any]) -> dict[str, Any]:
    if "error" in envelope:
        raise RuntimeError(f"hermes JSON-RPC error: {envelope['error']}")
    result = envelope.get("result") or {}
    for item in result.get("content") or []:
        if item.get("type") != "text":
            continue
        try:
            obj = json.loads(item.get("text") or "")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        if "error" in obj:
            raise RuntimeError(f"hermes generate_image error: {obj['error']}")
        if "url" in obj:
            return obj
    raise RuntimeError(f"hermes: response shape unexpected: {result!r}")


@mcp.tool()
async def generate_image(
    prompt: str,
    aspect_ratio: str = "1:1",
    resolution: str = "1k",
    quality: bool = False,
) -> list[TextContent | ImageContent]:
    """Generate one image from a text prompt.

    USE FOR:
        - Concept art, mockups, hero images, atmospheric visuals
        - Social-media assets, illustration, abstract or stylized scenes

    DON'T USE FOR:
        - Text rendered inside the image (logos, titles, labels, code).
          Generate a clean background here and overlay text via SVG/HTML
          on top, separately.
        - Diagrams or charts. Use mermaid for flow/architecture diagrams.

    Args:
        prompt: text-to-image description (English produces best results).
        aspect_ratio: "1:1" (default) | "16:9" | "9:16" | "4:3" | "3:4" | "21:9".
        resolution: "1k" (default) | "2k".
        quality: True for slower generation with more detail.

    Returns:
        Two content blocks:
            - TextContent: absolute file path of the saved image. When the
              tool is reached through image-hub, this path is automatically
              rewritten to a public https://image-hub.kitepon.dynv6.net/files/<id>
              URL before reaching the caller.
            - ImageContent: base64 of the same image, so the calling LLM
              can see and discuss the result inline.

    Limits:
        - One image per call. Call multiple times for variations.
        - Max output resolution: 2k.
        - Photorealistic faces of real living people may be refused.
    """
    envelope = await _call_hermes_generate_image(prompt, aspect_ratio, resolution, quality)
    payload = _extract_image_payload(envelope)
    url = payload["url"]
    mime = payload.get("mime_type") or "image/jpeg"
    ext = _EXT_BY_MIME.get(mime)
    if ext is None:
        # 未知 mime → ファイルを書いても intercept.ts の regex (png|jpg|jpeg|webp) に
        # マッチせず silent failure になるので、ここで停止して呼び出し元に伝える。
        raise RuntimeError(f"hermes: unsupported mime_type {mime!r}")

    _validate_image_url(url)
    async with httpx.AsyncClient(timeout=120.0) as client:
        img_resp = await client.get(url)
        img_resp.raise_for_status()
        img_bytes = img_resp.content

    os.makedirs(_TMPDIR, exist_ok=True)
    # intercept.ts の pathPattern と一致させる: openai_gen_image_<random>/generated_<n>.<ext>
    sub = tempfile.mkdtemp(prefix="openai_gen_image_", dir=_TMPDIR)
    os.chmod(sub, 0o755)  # image-hub-app uid 1000 から ro 参照するため world-readable に
    fname = f"generated_{uuid.uuid4().hex[:8]}{ext}"
    fpath = os.path.join(sub, fname)
    with open(fpath, "wb") as f:
        f.write(img_bytes)
    os.chmod(fpath, 0o644)

    b64 = base64.b64encode(img_bytes).decode("ascii")
    return [
        TextContent(type="text", text=fpath),
        ImageContent(type="image", data=b64, mimeType=mime),
    ]


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
