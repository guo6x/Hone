/**
 * Canvas HTTP 服务器 —— 提供文件服务 + WebSocket 自动刷新推送。
 *
 * 端口: HONE_CANVAS_PORT (默认 9120)
 * 文件目录: ~/.hone/canvas/<session>/
 * 访问: http://localhost:9120/<session>/
 */
import { createServer, type Server } from 'http'
import { readFile, readdir, stat } from 'fs/promises'
import { existsSync, watch } from 'fs'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'

const CANVAS_DIR = `${process.env.HOME || '~'}/.hone/canvas`

interface CanvasState {
  server: Server | null
  /** sessionId → Set of WebSocket responses (for live reload push) */
  watchers: Map<string, Set<any>>
  /** sessionId → file watcher */
  fileWatchers: Map<string, any>
  port: number
  running: boolean
}

const state: CanvasState = {
  server: null,
  watchers: new Map(),
  fileWatchers: new Map(),
  port: parseInt(process.env.HONE_CANVAS_PORT || '9120', 10),
  running: false,
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
}

const LIVE_RELOAD_SCRIPT = `
<script>
(function(){
  var ws = new WebSocket('ws://' + location.host + '/__live_reload__');
  ws.onmessage = function(m) {
    if (m.data === 'reload') location.reload();
  };
})();
</script>`

export function startCanvasServer(port?: number): number {
  if (state.server) return state.port

  state.port = port || state.port
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${state.port}`)
      const pathname = url.pathname

      // WebSocket upgrade for live reload
      if (pathname === '/__live_reload__') {
        handleLiveReload(req, res)
        return
      }

      // Session listing
      if (pathname === '/' || pathname === '') {
        const sessions = await listSessions()
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderIndexPage(sessions))
        return
      }

      // Serve canvas file: /:sessionId/:file
      const parts = pathname.slice(1).split('/')
      const sessionId = parts[0]
      const filePath = parts.slice(1).join('/') || 'index.html'
      const fullPath = join(CANVAS_DIR, sessionId, filePath)

      // Security: ensure path stays within canvas dir
      if (!fullPath.startsWith(join(CANVAS_DIR, sessionId))) {
        res.writeHead(403)
        res.end('禁止访问')
        return
      }

      let content: Buffer
      try {
        content = await readFile(fullPath)
      } catch {
        // If file not found, serve directory listing
        try {
          const files = await readdir(join(CANVAS_DIR, sessionId))
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderSessionPage(sessionId, files))
          return
        } catch {
          res.writeHead(404)
          res.end('Canvas 页面不存在')
          return
        }
      }

      const ext = extname(fullPath).toLowerCase()
      const mimeType = MIME[ext] || 'application/octet-stream'

      // Inject live reload script into HTML
      if (ext === '.html') {
        let html = content.toString('utf-8')
        if (!html.includes('__live_reload__')) {
          html = html.replace('</body>', `${LIVE_RELOAD_SCRIPT}</body>`)
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } else {
        res.writeHead(200, { 'Content-Type': mimeType })
        res.end(content)
      }
    } catch (err) {
      res.writeHead(500)
      res.end('服务器错误')
    }
  })

  server.listen(state.port, () => {
    state.running = true
    console.error(`[Canvas] 服务器已启动: http://localhost:${state.port}`)
  })

  state.server = server
  return state.port
}

export function stopCanvasServer(): void {
  if (state.server) {
    state.server.close()
    state.server = null
    state.running = false
  }
  // Close all file watchers
  for (const [, watcher] of state.fileWatchers) {
    watcher.close()
  }
  state.fileWatchers.clear()
  state.watchers.clear()
  console.error('[Canvas] 服务器已停止')
}

export function getCanvasPort(): number {
  return state.port
}

export function getCanvasUrl(sessionId: string): string {
  return `http://localhost:${state.port}/${sessionId}/`
}

/** 通知指定 session 的所有浏览器刷新 */
export function reloadCanvas(sessionId: string): void {
  const watchers = state.watchers.get(sessionId)
  if (watchers) {
    for (const ws of watchers) {
      try {
        ws.send('reload')
      } catch {
        watchers.delete(ws)
      }
    }
  }
}

// ── Private ────────────────────────────────────────────────

function handleLiveReload(req: any, res: any): void {
  // Simple WebSocket upgrade (works with Bun)
  const sessionId = req.headers['x-canvas-session'] || 'default'

  // Use Node.js server upgrade
  res.writeHead(101, {
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Accept': 'dummy', // Simplified for MVP
  })

  // Track this connection
  if (!state.watchers.has(sessionId)) {
    state.watchers.set(sessionId, new Set())
  }

  // Store the response object for push
  const watchers = state.watchers.get(sessionId)!
  watchers.add(res)

  // Handle disconnect
  req.on('close', () => {
    watchers.delete(res)
  })

  // Send initial connection ack
  try {
    res.write('connected')
  } catch {}
}

async function listSessions(): Promise<string[]> {
  try {
    const entries = await readdir(CANVAS_DIR)
    const sessions: string[] = []
    for (const entry of entries) {
      const fullPath = join(CANVAS_DIR, entry)
      const s = await stat(fullPath)
      if (s.isDirectory()) {
        sessions.push(entry)
      }
    }
    return sessions
  } catch {
    return []
  }
}

function renderIndexPage(sessions: string[]): string {
  const list = sessions.length === 0
    ? '<p style="color: #888">暂无 Canvas 会话</p>'
    : sessions.map(s =>
        `<li><a href="/${s}/">${escapeHtml(s)}</a></li>`
      ).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hone Canvas</title>
  <style>
    :root { --bg: #1a1a2e; --text: #e0e0e0; --accent: #4a9eff; }
    body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 24px; }
    h1 { color: var(--accent); } a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; } li { margin: 8px 0; }
  </style>
</head>
<body>
  <h1>Hone Canvas</h1>
  <ul>${list}</ul>
</body>
</html>`
}

function renderSessionPage(sessionId: string, files: string[]): string {
  const list = files.length === 0
    ? '<p style="color: #888">空目录</p>'
    : files.map(f =>
        `<li><a href="/${sessionId}/${f}">${escapeHtml(f)}</a></li>`
      ).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(sessionId)} - Hone Canvas</title>
  <style>
    :root { --bg: #1a1a2e; --text: #e0e0e0; --accent: #4a9eff; }
    body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 24px; }
    h1 { color: var(--accent); } a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; } li { margin: 8px 0; }
    .back { margin-bottom: 16px; display: inline-block; }
  </style>
</head>
<body>
  <a class="back" href="/">&larr; 返回</a>
  <h1>${escapeHtml(sessionId)}</h1>
  <ul>${list}</ul>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
