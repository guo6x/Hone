/**
 * Hone Gateway entry point — standalone daemon process.
 *
 * Usage: bun src/entrypoints/gateway.ts [options]
 *   --relay-url <url>          Cloudflare Relay URL (required)
 *   --machine-name <name>      Display name for this machine
 *   --verbose                  Enable verbose logging
 *   --stop                     Stop a running gateway
 *   --status                   Check if gateway is running
 *
 * Environment:
 *   HONE_RELAY_URL             Default relay URL
 *   HONE_GOD_MODE              Auto-approve device pairing
 */
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { startGateway, stopGateway, type GatewayConfig } from '../daemon/gateway.js'

const relayUrl = process.env.HONE_RELAY_URL || 'wss://hone-relay.marsailleippi79.workers.dev/connect'
const machineName = process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown'

// Persist a stable machineId so gateway identity survives restarts.
// Without this, every restart generates a new UUID and all paired clients
// can no longer address this gateway.
const honeDir = process.env.HONE_DATA_DIR || join(process.env.HOME || process.env.USERPROFILE || '.', '.hone')
const machineIdFile = join(honeDir, 'machine-id')
let machineId: string
try {
  machineId = readFileSync(machineIdFile, 'utf-8').trim()
} catch {
  machineId = randomUUID()
  try { mkdirSync(dirname(machineIdFile), { recursive: true }); writeFileSync(machineIdFile, machineId, 'utf-8') } catch {}
}

const pidFile = process.env.HONE_PID_FILE || join(honeDir, 'gateway.pid')

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--status')) {
    try {
      const fs = await import('fs/promises')
      const pid = await fs.readFile(pidFile, 'utf-8').catch(() => null)
      if (pid) {
        console.log(`Gateway 运行中 (PID: ${pid})`)
        process.exit(0)
      }
      console.log('Gateway 未运行')
    } catch {
      console.log('Gateway 未运行')
    }
    process.exit(0)
  }

  if (args.includes('--stop')) {
    try {
      const fs = await import('fs/promises')
      const pid = await fs.readFile(pidFile, 'utf-8').catch(() => null)
      if (pid) {
        const pidNum = Number(pid)
        // 校验进程身份：读取命令行确认是 gateway 进程，避免杀错被复用的 PID
        let isGateway = true
        try {
          const { execFileSync } = await import('child_process')
          const cmdline = process.platform === 'win32'
            ? execFileSync('wmic', ['process', 'where', `ProcessId=${pidNum}`, 'get', 'CommandLine'], { encoding: 'utf-8', timeout: 3000 })
            : execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf-8', timeout: 3000 })
          isGateway = /gateway|hone/i.test(cmdline)
        } catch {
          // wmic/ps 不可用时，信任 PID 文件
        }
        if (isGateway) {
          process.kill(pidNum, 'SIGTERM')
          console.log(`Gateway 已停止 (PID: ${pid})`)
          await fs.unlink(pidFile).catch(() => {})
        } else {
          console.log(`PID ${pid} 不是 Gateway 进程，跳过`)
          await fs.unlink(pidFile).catch(() => {})
        }
      } else {
        console.log('Gateway 未运行')
      }
    } catch (err) {
      console.error(`停止失败: ${err}`)
    }
    process.exit(0)
  }

  // Starting the gateway
  const config: GatewayConfig = {
    relayUrl: args.find(a => a.startsWith('--relay-url='))?.split('=')[1] || relayUrl,
    machineName: args.find(a => a.startsWith('--machine-name='))?.split('=')[1] || machineName,
    machineId,
    verbose: args.includes('--verbose'),
    repo: process.env.HONE_CURRENT_REPO,
    branch: process.env.HONE_CURRENT_BRANCH,
    authToken: process.env.HONE_AUTH_TOKEN,
    localAuthToken: process.env.HONE_LOCAL_AUTH_TOKEN,
    pairingId: process.env.HONE_PAIRING_ID,
    pairingCode: process.env.HONE_PAIRING_CODE,
    workspaceDir: process.env.HONE_WORKSPACE_DIR,
  }

  // Write PID file — 使用 honeDir（含 USERPROFILE 回退），与 pidFile 定义一致
  try {
    const fs = await import('fs/promises')
    await fs.mkdir(honeDir, { recursive: true }).catch(() => {})
    await fs.writeFile(pidFile, String(process.pid))
  } catch {}

  const state = await startGateway(config)

  // Handle shutdown gracefully
  // Re-entrancy guard: unhandledRejection / uncaughtException may fire while
  // shutdown is already in flight; without this guard they'd trigger a
  // recursive shutdown which double-closes resources.
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.error('\n[Gateway] 正在关闭...')
    try {
      await stopGateway(state)
    } catch (err) {
      console.error('[Gateway] 关闭错误:', err)
    }
    try {
      const fs = await import('fs/promises')
      await fs.unlink(pidFile).catch(() => {})
    } catch {}
    process.exit(0)
  }

  process.on('SIGINT', () => {
    // Second signal during shutdown: force exit immediately.
    if (shuttingDown) process.exit(130)
    shutdown()
  })
  process.on('SIGTERM', () => {
    if (shuttingDown) process.exit(143)
    shutdown()
  })
  process.on('unhandledRejection', (reason) => {
    console.error('\n[Gateway] 未处理的 Promise 拒绝:', reason)
    shutdown()
  })
  process.on('uncaughtException', (error) => {
    console.error('\n[Gateway] 未捕获的异常:', error)
    shutdown()
  })
}

main().catch(err => {
  console.error('[Gateway] 启动失败:', err)
  process.exit(1)
})
