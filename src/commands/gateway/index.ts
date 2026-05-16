import type { Command } from '../../commands.js'

const gateway = {
  type: 'local',
  name: 'gateway',
  description: '管理 Hone Gateway 守护进程 (start/stop/status/approve/deny)',
  aliases: ['gw'],
  supportsNonInteractive: true,
  load: () => import('./gateway.js'),
} satisfies Command

export default gateway
