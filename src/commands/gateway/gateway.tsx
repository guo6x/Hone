/**
 * /gateway command — manage Hone Gateway daemon from CLI.
 *
 * Subcommands:
 *   /gateway start   — Start the gateway daemon
 *   /gateway stop    — Stop the gateway daemon
 *   /gateway status  — Check gateway status
 *   /gateway approve <clientId> — Approve a pending device pairing
 *   /gateway deny <clientId>    — Deny a pending device pairing
 *   /gateway pairings           — List pending device pairings
 *
 * Approve/deny write a JSON file under ~/.hone/pairings/ that the daemon
 * polls; that's how cross-process signaling works between this slash
 * command and the long-running gateway process.
 */
import { spawn } from 'child_process'
import type { LocalCommandCall } from '../../types/command.js'

function honeHome(): string {
  return process.env.HOME || process.env.USERPROFILE || '~'
}

function honeDataDir(): string {
  return process.env.HONE_DATA_DIR || `${honeHome()}/.hone`
}

function pidFilePath(): string {
  return process.env.HONE_PID_FILE || `${honeDataDir()}/gateway.pid`
}

function pairingsDir(): string {
  return `${honeDataDir()}/pairings`
}

export const call: LocalCommandCall = async (args, _context) => {
  const parts = (args || '').trim().split(/\s+/)
  const subcommand = parts[0] || 'status'

  const honeDir = honeDataDir()
  const pidFile = pidFilePath()

  let result: string

  switch (subcommand) {
    case 'start': {
      const fs = await import('fs/promises')
      const configPath = `${honeDir}/config.json`
      let relayUrl = process.env.HONE_RELAY_URL

      try {
        const configData = await fs.readFile(configPath, 'utf-8')
        const config = JSON.parse(configData)
        if (config.relay_url && !relayUrl) {
          relayUrl = config.relay_url
        }
      } catch {
        // Fallback to default if no config file or parsing fails
      }

      if (!relayUrl) {
        relayUrl = 'wss://hone-relay.marsailleippi79.workers.dev/connect/default'
      }

      await fs.mkdir(honeDir, { recursive: true }).catch(() => {})

      const child = spawn(
        process.execPath,
        [process.argv[1]!, '--gateway-mode'],
        {
          env: {
            ...process.env,
            HONE_RELAY_URL: relayUrl,
            HONE_PID_FILE: pidFile,
            HONE_DATA_DIR: honeDir,
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

    case 'pairings': {
      const fs = await import('fs/promises')
      try {
        const dir = pairingsDir()
        const files = await fs.readdir(dir).catch(() => [] as string[])
        const pending = files.filter(f => f.endsWith('.pending.json'))
        if (pending.length === 0) {
          result = '当前没有等待批准的设备配对'
        } else {
          const lines: string[] = ['待批准设备配对:']
          for (const f of pending) {
            try {
              const data = JSON.parse(
                await fs.readFile(`${dir}/${f}`, 'utf-8'),
              )
              lines.push(
                `  ${data.clientId}  码: ${data.pairingCode || '—'}  时间: ${data.ts || '—'}`,
              )
            } catch {
              lines.push(`  ${f.replace('.pending.json', '')} (解析失败)`)
            }
          }
          lines.push('')
          lines.push('使用 /gateway approve <clientId> 批准，/gateway deny <clientId> 拒绝')
          result = lines.join('\n')
        }
      } catch (err) {
        result = `读取配对列表失败: ${err}`
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
        const fs = await import('fs/promises')
        const dir = pairingsDir()
        try {
          await fs.mkdir(dir, { recursive: true })
          const decision = {
            clientId,
            approved,
            ts: new Date().toISOString(),
          }
          await fs.writeFile(
            `${dir}/${clientId}.decision.json`,
            JSON.stringify(decision),
          )
          result = `${approved ? '已批准' : '已拒绝'} 设备: ${clientId} (Gateway 将在下次轮询时处理)`
        } catch (err) {
          result = `写入决定失败: ${err}`
        }
      }
      break
    }

    default:
      result = '用法: /gateway [start|stop|status|pairings|approve|deny]'
  }

  return { type: 'text', value: result }
}
