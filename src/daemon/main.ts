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

let runningState: GatewayState | null = null

export async function daemonMain(args: string[]): Promise<void> {
  const subcommand = args[0] || 'start'

  switch (subcommand) {
    case 'start': {
      if (runningState) {
        console.error('[Gateway] Gateway 已在运行中')
        return
      }

      const config: GatewayConfig = {
        relayUrl:
          process.env.HONE_RELAY_URL ||
          'wss://hone-relay.marsailleippi79.workers.dev/connect/default',
        machineName: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
        machineId: randomUUID(),
        verbose: args.includes('--verbose'),
      }

      runningState = await startGateway(config)

      // Keep process alive
      const shutdown = async () => {
        if (runningState) {
          await stopGateway(runningState)
          runningState = null
        }
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
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
