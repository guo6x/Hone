import type { Command } from '../../commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: '编辑 Hone 记忆文件',
  load: () => import('./memory.js'),
}

export default memory
