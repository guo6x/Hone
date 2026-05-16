/**
 * Hone Worker Registry — tracks connected CLI workers.
 *
 * Each CLI instance that connects to the Gateway registers as a worker.
 * The Gateway tracks capabilities (available tools, current workload)
 * and dispatches tasks to the least busy worker.
 */

interface WorkerInfo {
  id: string
  machineId: string
  machineName: string
  connectedAt: number
  lastSeen: number
  capabilities: string[]
  currentTask?: string
}

const workers = new Map<string, WorkerInfo>()

export function registerWorker(info: Omit<WorkerInfo, 'connectedAt' | 'lastSeen'>): void {
  workers.set(info.id, {
    ...info,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
  })
}

export function unregisterWorker(id: string): boolean {
  return workers.delete(id)
}

export function getWorker(id: string): WorkerInfo | undefined {
  return workers.get(id)
}

export function listWorkers(): WorkerInfo[] {
  return Array.from(workers.values())
}

export function getAvailableWorker(): WorkerInfo | undefined {
  for (const [, w] of workers) {
    if (!w.currentTask) return w
  }
  return undefined
}

export function runDaemonWorker(): void {
  // Placeholder — workers register themselves via WebSocket messages
}
