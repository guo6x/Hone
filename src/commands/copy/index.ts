/**
 * Copy command - minimal metadata only.
 * Implementation is lazy-loaded from copy.tsx to reduce startup time.
 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    '复制最近一次回复到剪贴板（/copy N 复制第 N 次）',
  load: () => import('./copy.js'),
} satisfies Command

export default copy
