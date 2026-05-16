import type { Command } from '../../commands.js'

const skills = {
  type: 'local-jsx',
  name: 'skills',
  description: '查看可用技能列表',
  load: () => import('./skills.js'),
} satisfies Command

export default skills
