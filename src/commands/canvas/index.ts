import type { Command } from '../../commands.js'

const canvas = {
  type: 'local',
  name: 'canvas',
  description: '打开 Canvas 可视化面板，AI 可实时生成图表输出到浏览器',
  aliases: ['view'],
  supportsNonInteractive: false,
  load: () => import('./canvas.js'),
} satisfies Command

export default canvas
