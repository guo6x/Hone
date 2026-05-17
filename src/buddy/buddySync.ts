import { WebSocket } from 'ws'
import { getGlobalConfig } from '../utils/config.js'
import { useSetAppState } from '../state/AppState.js'
import { useEffect } from 'react'

/**
 * CLI Buddy Sync — connects the terminal REPL to the Gateway Relay.
 * Updates the local AppState with real-time AI emotions and status.
 */
export function useCliBuddySync() {
  const setAppState = useSetAppState()
  
  useEffect(() => {
    const config = getGlobalConfig()
    const relayUrl = process.env.HONE_RELAY_URL || 'wss://hone-relay.marsailleippi79.workers.dev/connect/default'
    const machineId = config.userID || 'anon'

    let ws: WebSocket | null = null
    let reconnectTimer: NodeJS.Timeout | null = null
    let retryCount = 0

    const connect = () => {
      if (ws) ws.close()
      
      // We connect as a 'client' to listen to the gateway
      const url = `${relayUrl.replace('/connect/', '/client/')}`
      ws = new WebSocket(url)

      ws.on('open', () => {
        retryCount = 0
        console.error(`[Buddy] 已连接至中继同步状态`)
        // Register interest in buddy events
        ws?.send(JSON.stringify({ type: 'register', machineId }))
      })

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          
          switch (msg.type) {
            case 'buddy_event':
              setAppState(prev => ({
                ...prev,
                buddyStatus: msg.event,
                buddyText: msg.payload?.text
              }))
              break
            case 'task_started':
            case 'browser_task_started':
              setAppState(prev => ({
                ...prev,
                buddyStatus: 'working',
                buddyText: msg.task
              }))
              break
            case 'task_complete':
            case 'browser_task_result':
              setAppState(prev => ({
                ...prev,
                buddyStatus: msg.status === 'failed' ? 'error' : 'success',
                buddyText: msg.result || msg.error
              }))
              // Auto-idle after a while
              setTimeout(() => {
                setAppState(prev => ({ ...prev, buddyStatus: 'idle', buddyText: undefined }))
              }, 5000)
              break
          }
        } catch (err) {
          // ignore parse errors
        }
      })

      ws.on('close', () => {
        ws = null
        const delay = Math.min(30000, 1000 * Math.pow(2, retryCount))
        reconnectTimer = setTimeout(() => {
          retryCount++
          connect()
        }, delay)
      })

      ws.on('error', () => {
        ws?.close()
      })
    }

    connect()

    return () => {
      if (ws) ws.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [setAppState])
}
