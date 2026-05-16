import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    '显示 Hone 状态：版本、模型、账户、API 连通性、工具状态',
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
