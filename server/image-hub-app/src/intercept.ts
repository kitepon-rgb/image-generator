// intercept.ts — proxy response post-processing for image-generating MCPs.
//
// 上流 MCP が tool result の text content に「コンテナ内の絶対パス」を返してくる
// ケースを救う層。/var/lib/openai-image-tmp 配下を image-hub-app から ro マウントで
// 見えるようにしておき、proxy が tools/call レスポンスを buffer → SSE parse →
// 該当 path を検出 → SHA256 prefix12 で artifact 化 → text を /files/<id> URL に
// rewrite して再 emit する。
//
// 設計判断:
//   - 対象は `tools/call` レスポンスのみ (tools/list 等の discovery は素通り)
//   - 上流 MCP の `Image` content block (base64) は触らない (Bell が画像を見て
//     会話できる必要があるため、token cost は受容)
//   - file id = SHA256(content) prefix 12 文字 (collision 確率実用ゼロ、
//     idempotent: 同じ画像なら ON CONFLICT で artifact upsert)
//   - file が見つからない / size が cap を超える / それ以外の I/O エラーは
//     silent ではなく log + 元の path を残す (fallback 禁止ルールに準拠)
//
// 拡張: REWRITE_RULES に upstream 名 → RewriteRule を追加すれば mermaid /
// excalidraw も同じ仕組みに乗る (それぞれの path pattern を確認してから)。

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import type { Storage } from './storage.js';

export interface RewriteRule {
  pathPattern: RegExp;
  mimeByExt: Record<string, string>;
  maxFileBytes: number;
  project: string;
}

const OPENAI_IMAGE_RULE: RewriteRule = {
  // Python tempfile.mkdtemp(prefix="openai_gen_image_") が TMPDIR=/var/lib/openai-image-tmp
  // 配下に作る親ディレクトリ。子ファイル名は generated_xxx.{png,jpg,jpeg,webp}
  // (kazyam53/openai_gen_image_mcp の output_format 仕様に対応)。
  pathPattern: /\/var\/lib\/openai-image-tmp\/openai_gen_image_[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp)/g,
  mimeByExt: {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  },
  maxFileBytes: 32 * 1024 * 1024,
  project: 'openai-image',
};

export const REWRITE_RULES: Readonly<Record<string, RewriteRule>> = Object.freeze({
  'openai-image': OPENAI_IMAGE_RULE,
});

export interface InterceptDeps {
  storage: Storage;
  storageDir: string;
  publicFilesUrlBase: string;
  log: (msg: string) => void;
}

interface SseEvent {
  event: string;
  id: string;
  data: string;
}

function splitSseEvents(text: string): string[] {
  return text.split(/\r?\n\r?\n/);
}

function parseSseEvent(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  let id = '';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) {
      const v = line.slice(5);
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v);
    }
  }
  if (dataLines.length === 0) return null;
  return { event, id, data: dataLines.join('\n') };
}

function reEncodeSseEvent(ev: SseEvent): string {
  const lines: string[] = [];
  if (ev.event && ev.event !== 'message') lines.push(`event: ${ev.event}`);
  if (ev.id) lines.push(`id: ${ev.id}`);
  for (const dl of ev.data.split(/\r?\n/)) {
    lines.push(`data: ${dl}`);
  }
  return lines.join('\n') + '\n\n';
}

interface ToolCallEnvelope {
  jsonrpc?: string;
  id?: number | string;
  result?: {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    [k: string]: unknown;
  };
  error?: unknown;
  [k: string]: unknown;
}

function rewriteText(text: string, rule: RewriteRule, deps: InterceptDeps): { text: string; rewrites: number } {
  let rewrites = 0;
  const newText = text.replace(rule.pathPattern, (match) => {
    try {
      const st = statSync(match);
      if (!st.isFile()) {
        deps.log(`intercept: not a file, skip: ${match}`);
        return match;
      }
      if (st.size > rule.maxFileBytes) {
        deps.log(`intercept: file too large (${st.size} > ${rule.maxFileBytes}), skip: ${match}`);
        return match;
      }
      const buf = readFileSync(match);
      const sha = createHash('sha256').update(buf).digest('hex');
      const id = sha.slice(0, 12);
      const ext = extname(match).toLowerCase();
      const mime = rule.mimeByExt[ext] ?? 'application/octet-stream';
      const fileName = `${id}${ext}`;
      const destPath = join(deps.storageDir, fileName);
      if (!existsSync(destPath)) {
        mkdirSync(deps.storageDir, { recursive: true });
        copyFileSync(match, destPath);
      }
      deps.storage.putArtifact({ id, mime, project: rule.project });
      rewrites += 1;
      const url = `${deps.publicFilesUrlBase.replace(/\/$/, '')}/${fileName}`;
      return url;
    } catch (e) {
      deps.log(`intercept: rewrite skip for ${match}: ${e instanceof Error ? e.message : String(e)}`);
      return match;
    }
  });
  return { text: newText, rewrites };
}

function rewriteSseEventBlock(block: string, rule: RewriteRule, deps: InterceptDeps): { out: string; rewrites: number } {
  const ev = parseSseEvent(block);
  if (ev === null) return { out: block + '\n\n', rewrites: 0 };
  let parsed: ToolCallEnvelope | null = null;
  try {
    parsed = JSON.parse(ev.data) as ToolCallEnvelope;
  } catch {
    return { out: reEncodeSseEvent(ev), rewrites: 0 };
  }
  const content = parsed.result?.content;
  if (!Array.isArray(content)) {
    return { out: reEncodeSseEvent(ev), rewrites: 0 };
  }
  let total = 0;
  let touched = false;
  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') {
      const r = rewriteText(item.text, rule, deps);
      if (r.rewrites > 0) {
        item.text = r.text;
        touched = true;
        total += r.rewrites;
      }
    }
  }
  return {
    out: touched ? reEncodeSseEvent({ ...ev, data: JSON.stringify(parsed) }) : reEncodeSseEvent(ev),
    rewrites: total,
  };
}

// Streaming SSE rewrite Transform。upstream の Streamable HTTP は完了後も
// keep-alive で stream を閉じないため、buffering 戦略 (arrayBuffer) は undici
// の bodyTimeout (5 min) で死ぬ。Transform 経由で chunk が来た順に \n\n 区切りで
// イベントを切り出して書き戻し、stream 自体は閉じずに pipe しっぱなしにする。
export function makeSseRewriteTransform(ruleName: string, deps: InterceptDeps): Transform {
  const rule = REWRITE_RULES[ruleName];
  let textBuf = '';
  let totalRewrites = 0;
  const transform = new Transform({
    transform(chunk: Buffer | string, _enc, callback) {
      try {
        textBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let idx: number;
        while ((idx = textBuf.search(/\r?\n\r?\n/)) !== -1) {
          // separator のバイト数 (CRLF or LF) を保つ
          const sepMatch = textBuf.slice(idx).match(/^\r?\n\r?\n/);
          const sepLen = sepMatch !== null ? sepMatch[0].length : 2;
          const block = textBuf.slice(0, idx);
          textBuf = textBuf.slice(idx + sepLen);
          if (block.length === 0) {
            // empty event (keepalive ping etc) — 元のまま re-emit
            this.push('\n\n');
            continue;
          }
          if (rule === undefined) {
            // rule がない (ruleName 不在) なら rewrite せず素通し
            this.push(block + '\n\n');
            continue;
          }
          const r = rewriteSseEventBlock(block, rule, deps);
          totalRewrites += r.rewrites;
          this.push(r.out);
        }
        callback();
      } catch (e) {
        callback(e instanceof Error ? e : new Error(String(e)));
      }
    },
    flush(callback) {
      if (textBuf.length > 0) {
        // 末尾に separator なしで切れた残骸はそのまま流す
        this.push(textBuf);
        textBuf = '';
      }
      if (totalRewrites > 0) {
        deps.log(`intercept[${ruleName}]: rewrote ${totalRewrites} path(s) to /files URL`);
      }
      callback();
    },
  });
  return transform;
}

// 互換 API (1 ショット buffer 入力用、test や非 streaming 経路向け)。
export function maybeRewriteSseBody(body: Buffer, ruleName: string, deps: InterceptDeps): Buffer {
  const rule = REWRITE_RULES[ruleName];
  if (rule === undefined) return body;
  const text = body.toString('utf8');
  const blocks = splitSseEvents(text);
  let totalRewrites = 0;
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block === undefined || block.length === 0) continue;
    const r = rewriteSseEventBlock(block, rule, deps);
    totalRewrites += r.rewrites;
    out.push(r.out);
  }
  if (totalRewrites === 0) return body;
  deps.log(`intercept[${ruleName}]: rewrote ${totalRewrites} path(s) to /files URL`);
  return Buffer.from(out.join(''), 'utf8');
}

export function shouldIntercept(name: string, reqBody: unknown): boolean {
  if (!(name in REWRITE_RULES)) return false;
  if (typeof reqBody !== 'object' || reqBody === null) return false;
  return (reqBody as { method?: unknown }).method === 'tools/call';
}
