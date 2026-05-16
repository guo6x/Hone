import chalk from 'chalk'
import { logForDebugging } from 'src/utils/debug.js'
import { fileHistoryEnabled } from 'src/utils/fileHistory.js'
import {
  getInitialSettings,
  getSettings_DEPRECATED,
} from 'src/utils/settings/settings.js'
import { color } from '../../components/design-system/color.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { countConcurrentSessions } from '../../utils/concurrentSessions.js'
import { getGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'
import { getPlatform } from '../../utils/platform.js'
import { getCurrentSessionAgentColor, isCustomTitleEnabled } from '../../utils/sessionStorage.js'
import { getSessionsSinceLastShown } from './tipHistory.js'
import type { Tip, TipContext } from './types.js'

const externalTips: Tip[] = [
  // ── 新手引导 ──
  {
    id: 'new-user-warmup',
    content: async () =>
      '从小功能或 Bug 修复开始，让 Hone 先制定计划，再验证它的修改建议',
    cooldownSessions: 3,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups < 10
    },
  },
  {
    id: 'plan-mode-for-complex-tasks',
    content: async () =>
      `复杂任务前用计划模式先规划。按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 两次启用。`,
    cooldownSessions: 5,
    isRelevant: async () => {
      const config = getGlobalConfig()
      const daysSinceLastUse = config.lastPlanModeUse
        ? (Date.now() - config.lastPlanModeUse) / (1000 * 60 * 60 * 24)
        : Infinity
      return daysSinceLastUse > 7
    },
  },
  {
    id: 'todo-list',
    content: async () =>
      '处理复杂任务时让 Hone 创建任务列表，方便跟踪进度',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },

  // ── 工具使用 ──
  {
    id: 'permissions',
    content: async () =>
      '使用 /permissions 预批准常用工具（Bash、Edit 等），减少每次确认的打断',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 10
    },
  },
  {
    id: 'shift-tab-mode',
    content: async () =>
      `按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 在默认模式、自动接受编辑模式、计划模式之间切换`,
    cooldownSessions: 10,
    isRelevant: async () => true,
  },
  {
    id: 'enter-to-steer',
    content: async () =>
      'Hone 工作期间也可以发送消息，实时调整方向',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'prompt-queue',
    content: async () =>
      'Hone 工作时按 Enter 可以排队发送更多消息',
    cooldownSessions: 5,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.promptQueueUseCount <= 3
    },
  },
  {
    id: 'drag-and-drop-images',
    content: async () =>
      '可以把图片文件拖到终端里，Hone 能看懂',
    cooldownSessions: 10,
    isRelevant: async () => !env.isSSH(),
  },
  {
    id: 'image-paste',
    content: async () =>
      `用 ${getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')} 粘贴剪贴板里的图片`,
    cooldownSessions: 20,
    isRelevant: async () => true,
  },

  // ── 会话管理 ──
  {
    id: 'continue-resume',
    content: async () =>
      '运行 hone --continue 或 hone --resume 恢复之前的会话',
    cooldownSessions: 10,
    isRelevant: async () => true,
  },
  {
    id: 'rename-conversation',
    content: async () =>
      '用 /rename 给会话命名，方便以后在 /resume 中找到',
    cooldownSessions: 15,
    isRelevant: async () =>
      isCustomTitleEnabled() && getGlobalConfig().numStartups > 10,
  },
  {
    id: 'color-when-multi',
    content: async () =>
      '同时跑多个 Hone 会话？用 /color 和 /rename 区分它们',
    cooldownSessions: 10,
    isRelevant: async () => {
      if (getCurrentSessionAgentColor()) return false
      const count = await countConcurrentSessions()
      return count >= 2
    },
  },

  // ── 技能 (Skills) ──
  {
    id: 'custom-skills',
    content: async () =>
      '在项目目录或 ~/.hone/skills/ 下创建 .md 文件来定义自定义技能',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 10
    },
  },
  {
    id: 'custom-agents',
    content: async () =>
      '使用 /agents 为特定任务优化。例如：代码审查员、架构师、测试工程师',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },
  {
    id: 'agent-flag',
    content: async () =>
      '用 --agent <name> 直接以子代理模式启动会话',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },

  // ── Memory 记忆系统 ──
  {
    id: 'memory-system',
    content: async () =>
      'Hone 会自动记住你的偏好和工作习惯。用 /memory 查看和管理记忆',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.memoryUsageCount <= 0
    },
  },
  {
    id: 'memory-context',
    content: async () =>
      'Hone 的记忆包括：用户偏好、项目上下文、反馈、外部资源引用',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.memoryUsageCount > 0 && config.numStartups > 5
    },
  },

  // ── Gateway ──
  {
    id: 'gateway-status',
    content: async () =>
      '运行 hone gateway status 查看 Gateway 是否在线',
    cooldownSessions: 15,
    isRelevant: async () => true,
  },
  {
    id: 'gateway-schedule',
    content: async () =>
      '让 Gateway 帮你定时执行任务：在会话中说「每天早上 9 点检查依赖更新」',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },
  {
    id: 'gateway-remote',
    content: async () =>
      'Gateway 连上中继后，可以用手机远程给电脑发任务',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 3
    },
  },

  // ── Canvas 可视化 ──
  {
    id: 'canvas-visual',
    content: async () =>
      '对 Hone 说「帮我画个架构图」或「生成测试覆盖率热力图」，结果会显示在 Canvas 中',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 3
    },
  },
  {
    id: 'canvas-popout',
    content: async () =>
      'Canvas 支持在浏览器中独立打开查看和交互',
    cooldownSessions: 20,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 3
    },
  },

  // ── VS Code ──
  {
    id: 'vscode-ext',
    content: async () =>
      '安装了 Hone VS Code 插件？Ctrl+Alt+E 解释代码，Ctrl+Alt+O 优化建议，Ctrl+Alt+R 代码审查',
    cooldownSessions: 8,
    isRelevant: async () => true,
  },
  {
    id: 'vscode-sidebar',
    content: async () =>
      'VS Code 左侧 Hone 面板可以直接对话，无需切换窗口',
    cooldownSessions: 12,
    isRelevant: async () => true,
  },

  // ── 终端 / IDE ──
  {
    id: 'terminal-setup',
    content: async () =>
      env.terminal === 'Apple_Terminal'
        ? '运行 /terminal-setup 启用 Option+Enter 换行'
        : '运行 /terminal-setup 启用 Shift+Enter 换行',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      if (env.terminal === 'Apple_Terminal') {
        return !config.optionAsMetaKeyInstalled
      }
      return !config.shiftEnterKeyBindingInstalled
    },
  },
  {
    id: 'shift-enter',
    content: async () =>
      env.terminal === 'Apple_Terminal'
        ? '按 Option+Enter 发送多行消息'
        : '按 Shift+Enter 发送多行消息',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return Boolean(
        (env.terminal === 'Apple_Terminal'
          ? config.optionAsMetaKeyInstalled
          : config.shiftEnterKeyBindingInstalled) && config.numStartups > 3,
      )
    },
  },
  {
    id: 'double-esc',
    content: async () =>
      '双击 Esc 可以回退到之前的对话节点',
    cooldownSessions: 10,
    isRelevant: async () => !fileHistoryEnabled(),
  },
  {
    id: 'double-esc-code-restore',
    content: async () =>
      '双击 Esc 同时回退代码和对话到之前的状态',
    cooldownSessions: 10,
    isRelevant: async () => fileHistoryEnabled(),
  },

  // ── 主题 / 界面 ──
  {
    id: 'theme-command',
    content: async () => '使用 /theme 更换主题配色',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'status-line',
    content: async () =>
      '使用 /statusline 在输入框下方显示自定义状态条',
    cooldownSessions: 25,
    isRelevant: async () => getSettings_DEPRECATED().statusLine === undefined,
  },
  {
    id: 'colorterm-truecolor',
    content: async () =>
      '设置环境变量 COLORTERM=truecolor 获得更丰富的色彩',
    cooldownSessions: 30,
    isRelevant: async () => !process.env.COLORTERM && chalk.level < 3,
  },

  // ── Windows 专属 ──
  {
    id: 'powershell-tool',
    content: async () =>
      '设置 CLAUDE_CODE_USE_POWERSHELL_TOOL=1 启用 PowerShell 工具',
    cooldownSessions: 10,
    isRelevant: async () =>
      getPlatform() === 'windows' &&
      process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL === undefined,
  },

  // ── 工作流建议 ──
  {
    id: 'git-worktrees',
    content: async () =>
      '使用 git worktree 可以同时跑多个 Hone 会话，互不干扰',
    cooldownSessions: 10,
    isRelevant: async () => {
      try {
        const config = getGlobalConfig()
        const worktreeCount = 0 // simplified - no git worktree detection in Hone
        return worktreeCount <= 1 && config.numStartups > 50
      } catch (_) {
        return false
      }
    },
  },
  {
    id: 'feedback-command',
    content: async () => '使用 /feedback 帮我们改进 Hone！',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },
  {
    id: 'default-permission-mode',
    content: async () =>
      '使用 /config 修改默认权限模式（包括计划模式）',
    cooldownSessions: 10,
    isRelevant: async () => {
      try {
        const config = getGlobalConfig()
        const settings = getSettings_DEPRECATED()
        const hasUsedPlanMode = Boolean(config.lastPlanModeUse)
        const hasDefaultMode = Boolean(settings?.permissions?.defaultMode)
        return hasUsedPlanMode && !hasDefaultMode
      } catch (error) {
        logForDebugging(
          `Failed to check default-permission-mode tip relevance: ${error}`,
          { level: 'warn' },
        )
        return false
      }
    },
  },
]

function getCustomTips(): Tip[] {
  const settings = getInitialSettings()
  const override = settings.spinnerTipsOverride
  if (!override?.tips?.length) return []

  return override.tips.map((content, i) => ({
    id: `custom-tip-${i}`,
    content: async () => content,
    cooldownSessions: 0,
    isRelevant: async () => true,
  }))
}

export async function getRelevantTips(context?: TipContext): Promise<Tip[]> {
  const settings = getInitialSettings()
  const override = settings.spinnerTipsOverride
  const customTips = getCustomTips()

  if (override?.excludeDefault && customTips.length > 0) {
    return customTips
  }

  const tips = [...externalTips]
  const isRelevant = await Promise.all(tips.map(_ => _.isRelevant(context)))
  const filtered = tips
    .filter((_, index) => isRelevant[index])
    .filter(_ => getSessionsSinceLastShown(_.id) >= _.cooldownSessions)

  return [...filtered, ...customTips]
}
