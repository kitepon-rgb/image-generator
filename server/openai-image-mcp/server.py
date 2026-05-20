"""xai-image-mcp — X (Grok Imagine) 画像生成を HermesAgent 経由で叩く MCP server.

OpenAI 課金から脱却するため、旧 upstream (kazyam53/openai_gen_image_mcp) を置換。
出力 path 形式 (/var/lib/openai-image-tmp/openai_gen_image_*/generated_*.{ext}) は
image-hub-app の intercept.ts (REWRITE_RULES['openai-image']) に拾わせるため
そのまま維持する。

HermesAgent 接続: MCP 標準 OAuth 2.1 (DCR + authorization_code + refresh_token
rotation) を使用。初回 consent はブラウザ必須なので bootstrap_oauth.py を 1 回
手動で走らせて state ファイルを生成 → このコンテナの HERMES_OAUTH_STATE_PATH
(bind mount) に置く。以降は refresh_token rotation を自動で回し、新 token を
state ファイルに書き戻す。
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from mcp.client.auth import OAuthClientProvider, TokenStorage
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.server.fastmcp import FastMCP
from mcp.shared.auth import (
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthToken,
)
from mcp.types import ImageContent, TextContent

from hermes_oauth import ensure_fresh_access_token


def _require_env(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise SystemExit(f"FATAL: required env var {key!r} is not set")
    return v


mcp = FastMCP("openai-image")

_HERMES_URL = _require_env("HERMES_MCP_URL")
_OAUTH_STATE_PATH = Path(
    os.environ.get("HERMES_OAUTH_STATE_PATH", "/var/lib/hermes-oauth/state.json")
)
_TMPDIR = os.environ.get("TMPDIR", "/var/lib/openai-image-tmp")

# imgen.x.ai 配下のみ image download を許可。url は外部入力 (Hermes 経由とはいえ
# 上流 server を信用しすぎない) なので、 Docker 内部ネットワークや file:// 系への
# 飛び方を SSRF guard で阻止する。
_ALLOWED_IMAGE_HOST_SUFFIX = ".x.ai"

_EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
}


class FileTokenStorage(TokenStorage):
    """OAuthClientProvider 用の永続ストレージ.

    refresh_token rotation 後の新 token を atomic write (.tmp → rename) で
    書き戻し、 ファイルパーミッションは 0o600 に保つ (bind mount 経由でホストに
    出るため)。 client_info (DCR の結果) と tokens (access/refresh) を同一
    JSON にまとめて保管する。
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()

    async def _read(self) -> dict[str, Any]:
        if not self._path.exists():
            return {}
        return json.loads(self._path.read_text())

    async def _write(self, data: dict[str, Any]) -> None:
        async with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2))
            os.chmod(tmp, 0o600)
            tmp.replace(self._path)

    async def get_tokens(self) -> OAuthToken | None:
        data = await self._read()
        raw = data.get("tokens")
        return OAuthToken.model_validate(raw) if raw else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        data = await self._read()
        data["tokens"] = tokens.model_dump(mode="json")
        await self._write(data)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        data = await self._read()
        raw = data.get("client_info")
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def set_client_info(self, info: OAuthClientInformationFull) -> None:
        data = await self._read()
        data["client_info"] = info.model_dump(mode="json")
        await self._write(data)


async def _refuse_redirect(_url: str) -> None:
    raise RuntimeError(
        f"FATAL: Hermes OAuth bootstrap required. "
        f"Run bootstrap_oauth.py on a host with a browser, then copy the "
        f"resulting state file to {_OAUTH_STATE_PATH}."
    )


async def _refuse_callback() -> tuple[str, str | None]:
    raise RuntimeError(
        "FATAL: Hermes OAuth callback fired in server mode — "
        "this only happens during bootstrap, never at runtime"
    )


def _make_auth_provider() -> OAuthClientProvider:
    return OAuthClientProvider(
        server_url=_HERMES_URL,
        client_metadata=OAuthClientMetadata(
            redirect_uris=["http://localhost:9999/callback"],
            client_name="image-hub-openai-image",
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
        ),
        storage=FileTokenStorage(_OAUTH_STATE_PATH),
        redirect_handler=_refuse_redirect,
        callback_handler=_refuse_callback,
    )


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


def _extract_image_payload(content: list[Any]) -> dict[str, Any]:
    for item in content:
        # CallToolResult.content は MCP SDK が typed (TextContent / ImageContent etc.)
        # にデシリアライズして渡してくる。
        item_type = getattr(item, "type", None)
        if item_type != "text":
            continue
        text = getattr(item, "text", None)
        if not text:
            continue
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        if "error" in obj:
            raise RuntimeError(f"hermes generate_image error: {obj['error']}")
        if "url" in obj:
            return obj
    raise RuntimeError("hermes: response shape unexpected (no text content with url)")


async def _call_hermes_generate_image(
    prompt: str,
    aspect_ratio: str,
    resolution: str,
    quality: bool,
) -> dict[str, Any]:
    # MCP SDK は access_token の有効期限を state ファイルから復元しないため、
    # 期限切れトークンをそのまま投げて 401 → ブラウザ flow → _refuse_redirect で
    # 即死する。 Hermes を叩く前に 1 時間 TTL を自前で事前更新しておく
    # (詳細は hermes_oauth.py)。 sync 関数なのでイベントループを塞がないよう別スレッドへ。
    await asyncio.to_thread(ensure_fresh_access_token)
    auth = _make_auth_provider()
    async with streamablehttp_client(_HERMES_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(
                "generate_image",
                {
                    "prompt": prompt,
                    "aspect_ratio": aspect_ratio,
                    "resolution": resolution,
                    "quality": quality,
                },
            )
    if result.isError:
        raise RuntimeError(f"hermes generate_image isError: {result.content!r}")
    return _extract_image_payload(result.content)


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
    payload = await _call_hermes_generate_image(prompt, aspect_ratio, resolution, quality)
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
