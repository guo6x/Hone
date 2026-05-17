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
import { startGateway, stopGateway, type GatewayConfig } from '../daemon/gateway.js'

const relayUrl = process.env.HONE_RELAY_URL || 'wss://hone-relay.marsailleippi79.workers.dev/connect/default'
const machineName = process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown'
const machineId = randomUUID()
const pidFile = process.env.HONE_PID_FILE || `${process.env.HOME || '~'}/.hone/gateway.pid`

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
        process.kill(Number(pid), 'SIGTERM')
        console.log(`Gateway 已停止 (PID: ${pid})`)
        await fs.unlink(pidFile).catch(() => {})
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
  }

  // Write PID file
  try {
    const fs = await import('fs/promises')
    const dir = `${process.env.HOME || '~'}/.hone`
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    await fs.writeFile(pidFile, String(process.pid))
  } catch {}

  const state = await startGateway(config)

  // Handle shutdown gracefully
  const shutdown = async () => {
    console.error('\n[Gateway] 正在关闭...')
    await stopGateway(state)
    try {
      const fs = await import('fs/promises')
      await fs.unlink(pidFile).catch(() => {})
    } catch {}
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
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
