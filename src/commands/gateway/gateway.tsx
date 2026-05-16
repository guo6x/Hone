/**
 * /gateway command — manage Hone Gateway daemon from CLI.
 *
 * Subcommands:
 *   /gateway start   — Start the gateway daemon
 *   /gateway stop    — Stop the gateway daemon
 *   /gateway status  — Check gateway status
 *   /gateway approve <clientId> — Approve a pending device pairing
 *   /gateway deny <clientId>    — Deny a pending device pairing
 */
import { spawn } from 'child_process'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: any,
  args?: string,
): Promise<string | null> {
  const parts = (args || '').trim().split(/\s+/)
  const subcommand = parts[0] || 'status'

  let result: string

  switch (subcommand) {
    case 'start': {
      const relayUrl =
        process.env.HONE_RELAY_URL ||
        'wss://hone-relay.marsailleippi79.workers.dev/connect/default'

      const child = spawn(
        process.execPath,
        [process.argv[1], '--gateway-mode'],
        {
          env: {
            ...process.env,
            HONE_RELAY_URL: relayUrl,
            HONE_PID_FILE: `${process.env.HOME || '~'}/.hone/gateway.pid`,
          },
          detached: true,
          stdio: 'ignore',
        },
      )
      child.unref()
      result = `Gateway 已启动 (PID: ${child.pid})\n中继: ${relayUrl}`
      break
    }

    case 'stop': {
      const fs = await import('fs/promises')
      const pidFile = `${process.env.HOME || '~'}/.hone/gateway.pid`
      try {
        const pid = await fs.readFile(pidFile, 'utf-8')
        process.kill(Number(pid), 'SIGTERM')
        await fs.unlink(pidFile).catch(() => {})
        result = `Gateway 已停止 (PID: ${pid})`
      } catch {
        result = 'Gateway 未运行'
      }
      break
    }

    case 'status': {
      const fs = await import('fs/promises')
      const pidFile = `${process.env.HOME || '~'}/.hone/gateway.pid`
      try {
        const pid = await fs.readFile(pidFile, 'utf-8')
        try {
          process.kill(Number(pid), 0)
          result = `Gateway 运行中 (PID: ${pid})`
        } catch {
          await fs.unlink(pidFile).catch(() => {})
          result = 'Gateway 未运行 (残留 PID 文件已清理)'
        }
      } catch {
        result = 'Gateway 未运行'
      }
      break
    }

    case 'approve':
    case 'deny': {
      const clientId = parts[1]
      if (!clientId) {
        result = `用法: /gateway ${subcommand} <clientId>`
      } else {
        const approved = subcommand === 'approve'
        process.env[`HONE_PAIRING_${clientId}`] = approved ? 'approved' : 'denied'
        result = `${approved ? '已批准' : '已拒绝'} 设备: ${clientId}`
      }
      break
    }

    default:
      result = '用法: /gateway [start|stop|status|approve|deny]'
  }

  onDone(result)
  return null
}
