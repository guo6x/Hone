import { feature } from 'E:/ai-work/claude-code-main/src/bundle-shim.js'
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js'
import type { Command } from '../../commands.js'

function isEnabled(): boolean {
  if (process.env.USER_TYPE === 'hone' || process.env.HONE_GOD_MODE === '1') {
    return true
  }
  if (!false) {
    return false
  }
  return isBridgeEnabled()
}

const bridge = {
  type: 'local-jsx',
  name: 'remote-control',
  aliases: ['rc'],
  description: '将当前终端接入远程控制会话',
  argumentHint: '[name]',
  isEnabled,
  get isHidden() {
    return !isEnabled()
  },
  immediate: true,
  load: () => import('./bridge.js'),
} satisfies Command

export default bridge


