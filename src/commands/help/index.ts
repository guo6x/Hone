import type { Command } from '../../commands.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: '显示帮助信息和可用命令',
  load: () => import('./help.js'),
} satisfies Command

export default help
