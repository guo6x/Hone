import type { Command } from '../../commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: '查看 Hone 使用统计和活动',
  load: () => import('./stats.js'),
} satisfies Command

export default stats
