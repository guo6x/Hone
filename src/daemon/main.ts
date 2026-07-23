/**
 * Hone Gateway Daemon entry point.
 *
 * Called from cli.tsx when `hone daemon <subcommand>` is invoked.
 * Handles start/stop/status/pairing subcommands via the gateway module.
 */
import {
  startGateway,
  stopGateway,
  type GatewayConfig,
  type GatewayState,
} from './gateway.js'
import { randomUUID } from 'crypto'
import { readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * 读取 Desktop 写入的敏感凭据文件（HONE_SECRETS_FILE），注入到 process.env 后删除文件。
 * 这样 API Key 不会通过环境变量传递给子进程（避免 /proc/{pid}/environ 泄露）。
 */
async function loadSecretsFile(): Promise<void> {
  const secretsFile = process.env.HONE_SECRETS_FILE
  if (!secretsFile || !existsSync(secretsFile)) return
  try {
    const content = await readFile(secretsFile, 'utf-8')
    const secrets = JSON.parse(content) as [string, string][]
    for (const [key, value] of secrets) {
      if (!process.env[key]) process.env[key] = value
    }
    await unlink(secretsFile)
    delete process.env.HONE_SECRETS_FILE
  } catch (err) {
    console.error('[Gateway] Failed to read secrets file:', err)
    // 即使读取失败也要尽力删除，避免 secrets 文件残留泄露 API Key
    try { await unlink(secretsFile) } catch {}
    delete process.env.HONE_SECRETS_FILE
  }
}

/**
 * 加载或生成持久化的 machineId，避免每次重启生成新 ID 导致 Dashboard 重复记录。
 */
async function loadOrCreateMachineId(): Promise<string> {
  const fs = await import('fs/promises')
  const idFile = join(homedir(), '.hone', 'machine-id')
  try {
    if (existsSync(idFile)) {
      const id = (await fs.readFile(idFile, 'utf-8')).trim()
      if (id) return id
    }
  } catch {}
  const newId = randomUUID()
  try {
    await fs.mkdir(join(homedir(), '.hone'), { recursive: true })
    await fs.writeFile(idFile, newId, { mode: 0o600 })
  } catch {}
  return newId
}

let runningState: GatewayState | null = null

export async function daemonMain(args: string[]): Promise<void> {
  const subcommand = args[0] || 'start'

  switch (subcommand) {
    case 'start': {
      if (runningState) {
        console.error('[Gateway] Gateway 已在运行中')
        return
      }

      // 读取敏感凭据文件（由 Desktop 写入），注入到 process.env 后删除
      await loadSecretsFile()
      // 加载持久化的 machineId（避免每次重启生成新 ID）
      const machineId = await loadOrCreateMachineId()

      const config: GatewayConfig = {
        relayUrl:
          process.env.HONE_RELAY_URL ||
          'wss://hone-relay.marsailleippi79.workers.dev/connect/default',
        machineName: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
        machineId,
        verbose: args.includes('--verbose'),
        authToken: process.env.HONE_AUTH_TOKEN,
        localAuthToken: process.env.HONE_LOCAL_AUTH_TOKEN,
        pairingId: process.env.HONE_PAIRING_ID,
        pairingCode: process.env.HONE_PAIRING_CODE,
        workspaceDir: process.env.HONE_WORKSPACE_DIR,
      }

      // shutdown 带超时，防止 stopGateway 挂起导致进程无法退出。
      // 用 shuttingDown 标志位 + process.once：第二次 Ctrl+C 不再触发新 shutdown，
      // 避免中断正在进行的 stopGateway（closeDb 未完成 / localServer 未 close / browser 子进程变孤儿）。
      let shuttingDown = false
      const shutdown = async () => {
        if (shuttingDown) return
        shuttingDown = true
        if (runningState) {
          const state = runningState
          runningState = null
          // 5 秒超时，超时后强制退出
          const timeout = setTimeout(() => {
            console.error('[Gateway] shutdown 超时，强制退出')
            process.exit(1)
          }, 5000)
          try {
            await stopGateway(state)
          } catch (err) {
            console.error('[Gateway] shutdown error:', err)
          }
          clearTimeout(timeout)
        }
        process.exit(0)
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)

      runningState = await startGateway(config)
      break
    }

    case 'stop': {
      if (runningState) {
        await stopGateway(runningState)
        runningState = null
        console.error('[Gateway] 已停止')
      } else {
        console.error('[Gateway] 未在运行')
      }
      break
    }

    case 'status': {
      if (runningState && runningState.connected) {
        console.error(
          `[Gateway] 运行中 | 机器: ${runningState.config.machineName} | 中继: ${runningState.config.relayUrl}`,
        )
      } else if (runningState) {
        console.error('[Gateway] 运行中但未连接中继')
      } else {
        console.error('[Gateway] 未在运行')
      }
      break
    }

    default: {
      console.error('用法: hone daemon [start|stop|status]')
      break
    }
  }
}
