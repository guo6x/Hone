import { feature } from 'E:/ai-work/claude-code-main/src/bundle-shim.js'
import type { Command } from '../../commands.js'

const branch = {
  type: 'local-jsx',
  name: 'branch',
  // 'fork' alias only when /fork doesn't exist as its own command
  aliases: false ? [] : ['fork'],
  description: '在此创建当前对话的分支',
  argumentHint: '[name]',
  load: () => import('./branch.js'),
} satisfies Command

export default branch


