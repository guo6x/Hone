/**
 * /canvas 命令 —— 管理 Canvas 可视化面板。
 *
 * 用法:
 *   /canvas             打开 Canvas 首页
 *   /canvas start       启动 Canvas 服务器
 *   /canvas stop        停止 Canvas 服务器
 *   /canvas status      查看运行状态
 */
import { exec } from 'child_process'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  startCanvasServer,
  stopCanvasServer,
  getCanvasPort,
} from '../../canvas/server.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: any,
  args?: string,
): Promise<string | null> {
  const parts = (args || '').trim().split(/\s+/)
  const subcommand = parts[0] || 'open'

  switch (subcommand) {
    case 'start': {
      const port = startCanvasServer()
      onDone(`Canvas 服务器已启动\n地址: http://localhost:${port}`)
      break
    }

    case 'stop': {
      stopCanvasServer()
      onDone('Canvas 服务器已停止')
      break
    }

    case 'status': {
      try {
        const port = getCanvasPort()
        onDone(`Canvas 运行中\n地址: http://localhost:${port}`)
      } catch {
        onDone('Canvas 未启动')
      }
      break
    }

    case 'open':
    default: {
      const port = startCanvasServer()

      // 尝试打开浏览器
      const url = `http://localhost:${port}`
      const platform = process.platform
      try {
        if (platform === 'darwin') {
          exec(`open "${url}"`)
        } else if (platform === 'win32') {
          exec(`start "" "${url}"`)
        } else {
          exec(`xdg-open "${url}"`)
        }
      } catch {
        // 浏览器打开失败不是致命错误
      }

      onDone(`Canvas 已打开\n${url}`)
    }
  }

  return null
}
