# sitecustomize.py — Python 起動時に自動 import される hook。
#
# 目的: image-hub-app (uid 1000 node) が openai-image-mcp (uid 0 root) の
# tempfile.mkdtemp 出力ディレクトリを読めるよう、mkdtemp が固定で 0o700 で
# 作るのを 0o755 にチmod する monkey-patch をかける。
# (mkdtemp の mode 引数は廃止されており Python レベルで 0o700 固定のため)。
#
# ファイル本体は Python が open() で書き込む際 umask 022 → 0644 になるので
# そのまま image-hub-app から read 可能。
#
# 副作用: 同じプロセス内の他の mkdtemp 呼出も world-readable 化する。
# このコンテナは openai-image MCP 専用 (uvx tool でラップされた単一プロセス) で
# 機密性のある一時ディレクトリは作らない想定なので許容。

import tempfile as _tempfile
import os as _os

_orig_mkdtemp = _tempfile.mkdtemp


def _mkdtemp_world_readable(*args, **kwargs):
    path = _orig_mkdtemp(*args, **kwargs)
    try:
        _os.chmod(path, 0o755)
    except OSError:
        # FALLBACK-ALLOWED: 失敗しても元の動作 (0o700) で続行する方が安全
        # (例外条件 3: 最終救命的な hook で他に書く場所がない)
        pass
    return path


_tempfile.mkdtemp = _mkdtemp_world_readable
