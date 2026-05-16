import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: '查看使用量限制',
  availability: ['claude-ai'],
  load: () => import('./usage.js'),
} satisfies Command
