export type Lang = 'zh' | 'en';

export interface Translations {
  // Tabs
  tabDashboard: string;
  tabGateway: string;
  tabWorkspace: string;
  tabWatch: string;
  tabSchedule: string;
  tabCanvas: string;
  tabSettings: string;

  // Sidebar
  sidebarTitle: string;
  sidebarSessions: string;
  sidebarAdd: string;
  sidebarLangToggle: string;
  sidebarRelayActive: string;

  // Machine status
  statusOnline: string;
  statusBusy: string;
  statusOffline: string;

  // Empty / Loading / Error
  emptyTitle: string;
  emptyDesc: string;
  emptyBtn: string;
  loadingTitle: string;
  loadingDesc: string;
  errorTitle: string;
  errorDesc: string;
  errorBtn: string;

  // Dashboard
  cardsMachinesTitle: string;
  cardsMachinesDesc: string;
  cardsSessionsTitle: string;
  cardsSessionsDesc: string;
  cardsTokensTitle: string;
  cardsTokensDesc: string;
  cardsTasksTitle: string;
  cardsTasksDesc: string;
  tableTitle: string;
  tableColMachine: string;
  tableColStatus: string;
  tableColTask: string;
  tableColTokens: string;
  tableColTime: string;
  tableSearch: string;
  tableFilterAll: string;
  tableFilterLive: string;
  tableFilterIdle: string;
  tableFilterDone: string;
  badgeLive: string;
  badgeIdle: string;
  badgeDone: string;
  activityTitle: string;
  statusUptime: string;
  statusLatency: string;
  statusTokens: string;
  statusBackup: string;

  // Schedule
  schedEmptyTitle: string;
  schedEmptyDesc: string;
  schedEmptyBtn: string;
  schedCardNext: string;
  schedCardSuccess: string;
  schedCardFail: string;
  schedNewBtn: string;
  schedFilterAll: string;
  schedFilterActive: string;
  schedFilterPaused: string;
  schedFilterCompleted: string;
  schedSearchPlaceholder: string;
  aiTitle: string;
  aiDismiss: string;
  modalNewTitle: string;
  modalEditTitle: string;
  modalNLLabel: string;
  modalTriggerLabel: string;
  modalTimeLabel: string;
  modalDescLabel: string;
  modalDeliveryLabel: string;
  modalDeliveryDesktop: string;
  modalDeliveryCli: string;
  modalDeliverySession: string;
  modalNLPlaceholder: string;
  modalTimePlaceholder: string;
  modalDescPlaceholder: string;
  modalCancel: string;
  modalTest: string;
  modalSave: string;
  modalTriggerCron: string;
  modalTriggerInterval: string;
  modalTriggerOnce: string;

  // Canvas
  canvasRefresh: string;
  canvasPopout: string;
  canvasUpdated: string;
  canvasError: string;
  canvasRetry: string;
  canvasEmptyTitle: string;
  canvasEmptyDesc: string;
  canvasEmptyHint: string;

  // Settings
  settingsProvider: string;
  settingsGateway: string;
  settingsData: string;
  settingsAppearance: string;
  settingsAbout: string;
  setProviderTitle: string;
  setProviderDesc: string;
  setProviderLabel: string;
  setApiKeyLabel: string;
  setApiKeyShow: string;
  setApiKeyHide: string;
  setModelLabel: string;
  setGatewayTitle: string;
  setGatewayDesc: string;
  setAutoStartLabel: string;
  setAutoStartDesc: string;
  setRelayUrlLabel: string;
  setPortLabel: string;
  setPortDesc: string;
  setDataTitle: string;
  setDataDesc: string;
  setWorkspaceLabel: string;
  setWorkspaceDesc: string;
  setLogRetentionLabel: string;
  setClearDataLabel: string;
  setClearDataDesc: string;
  setClearDataBtn: string;
  setConfirmTitle: string;
  setConfirmBtn: string;
  setCancelBtn: string;
  setAppearanceTitle: string;
  setAppearanceDesc: string;
  setVersionLabel: string;
  setUpdateBtn: string;
  setUpdated: string;
  setDocsLink: string;
  setLicenseLabel: string;

  // Gateway Chat
  gwTitle: string;
  gwOnline: string;
  gwThinking: string;
  gwOffline: string;
  gwStart: string;
  gwStop: string;
  gwStarting: string;
  gwStopping: string;
  gwSearch: string;
  gwPlaceholder: string;
  gwSend: string;
  gwQuickDispatch: string;
  gwQuickStatus: string;
  gwQuickSchedule: string;
  gwQuickCanvas: string;
  gwWelcome: string;
  gwMsg1: string;
  gwMsg2: string;
  gwMsg3: string;
  gwConnected: string;

  // Device Pairing
  pairTitle: string;
  pairDesc: string;
  pairLocal: string;
  pairSSH: string;
  pairTunnel: string;
  pairCode: string;
  pairCodeDesc: string;
  pairCodePlaceholder: string;
  pairHost: string;
  pairHostPlaceholder: string;
  pairPort: string;
  pairConnect: string;
  pairConnecting: string;
  pairConnected: string;
  pairFailed: string;
  pairCancel: string;

  // Skills & MCP
  skillsTitle: string;
  skillsDesc: string;
  skillsAdd: string;
  skillEnabled: string;
  skillDisabled: string;
  mcpTitle: string;
  mcpDesc: string;
  mcpAdd: string;
  mcpConnected: string;
  mcpDisconnected: string;
  mcpError: string;
  mcpConfigLabel: string;
  mcpToolsLabel: string;

  // Browser
  tabWebtask: string;
  browserSettings: string;
  browserSettingsTitle: string;
  browserSettingsDesc: string;
  browserEnabledLabel: string;
  browserEnabledDesc: string;
  browserGuiModelLabel: string;
  browserGuiModelDesc: string;
  browserHeadlessLabel: string;
  browserHeadlessDesc: string;
  browserMaxStepsLabel: string;
  browserMaxStepsDesc: string;
  webtaskTitle: string;
  webtaskDesc: string;
  webtaskInput: string;
  webtaskUrl: string;
  webtaskSubmit: string;
  webtaskSubmitting: string;
  webtaskLowRisk: string;
  webtaskMediumRisk: string;
  webtaskHighRisk: string;
  webtaskStep: string;
  webtaskSteps: string;
  webtaskSuccess: string;
  webtaskFailed: string;
  webtaskTimeout: string;
  webtaskCancelled: string;
  webtaskEmpty: string;
  webtaskEmptyDesc: string;
  webtaskPlaceholder: string;
}

const zh: Translations = {
  tabDashboard: '仪表盘',
  tabGateway: '对话',
  tabSchedule: '日程管理',
  tabWorkspace: '工作台',
  tabWatch: '盯盘',
  tabCanvas: '可视化',
  tabSettings: '设置',
  sidebarTitle: '机器列表',
  sidebarSessions: '个会话',
  sidebarAdd: '+ 添加机器',
  sidebarLangToggle: 'EN',
  sidebarRelayActive: '中继活跃',
  statusOnline: '在线',
  statusBusy: '忙碌',
  statusOffline: '离线',
  emptyTitle: '还没有机器连接',
  emptyDesc: '连接一台运行 Hone Agent 的远程机器，开始管理 AI 编码助手。支持 Linux、macOS、Windows。',
  emptyBtn: '添加第一台机器',
  loadingTitle: '加载中…',
  loadingDesc: '正在连接 Hone 网关…',
  errorTitle: '连接失败',
  errorDesc: '无法连接到 Hone Relay。请检查网络连接和网关状态。',
  errorBtn: '重试',
  cardsMachinesTitle: '在线机器',
  cardsMachinesDesc: '1 台忙碌',
  cardsSessionsTitle: '活跃会话',
  cardsSessionsDesc: '4 个进行中',
  cardsTokensTitle: '今日 Token',
  cardsTokensDesc: '峰值 2.8k',
  cardsTasksTitle: '计划任务',
  cardsTasksDesc: '下次 2:00',
  tableTitle: '会话列表',
  tableColMachine: '机器',
  tableColStatus: '状态',
  tableColTask: '任务',
  tableColTokens: 'Token',
  tableColTime: '耗时',
  tableSearch: '搜索…',
  tableFilterAll: '全部',
  tableFilterLive: '进行中',
  tableFilterIdle: '空闲',
  tableFilterDone: '已完成',
  badgeLive: '进行中',
  badgeIdle: '空闲',
  badgeDone: '已完成',
  activityTitle: '最近活动',
  statusUptime: '运行时间',
  statusLatency: '延迟',
  statusTokens: '今日 Token',
  statusBackup: '上次备份',
  schedEmptyTitle: '还没有日程',
  schedEmptyDesc: '让 Hone 按时自动帮你干活。用自然语言描述你想定期执行的任务，AI 会自动解析成排程。',
  schedEmptyBtn: '创建第一个日程',
  schedCardNext: '下次执行',
  schedCardSuccess: '✓ 成功',
  schedCardFail: '✗ 失败',
  schedNewBtn: '+ 新建日程',
  schedFilterAll: '全部',
  schedFilterActive: '启用',
  schedFilterPaused: '暂停',
  schedFilterCompleted: '完成',
  schedSearchPlaceholder: '搜索日程…',
  aiTitle: '✨ Hone 发现了规律',
  aiDismiss: '忽略',
  modalNewTitle: '新建日程',
  modalEditTitle: '编辑日程',
  modalNLLabel: '自然语言输入',
  modalTriggerLabel: '触发类型',
  modalTimeLabel: '时间 / Cron',
  modalDescLabel: '任务描述',
  modalDeliveryLabel: '投递方式',
  modalDeliveryDesktop: '桌面通知',
  modalDeliveryCli: 'CLI 输出',
  modalDeliverySession: '留存在会话',
  modalNLPlaceholder: 'e.g., 每天早上9点检查我的GitHub PR',
  modalTimePlaceholder: '0 9 * * 1-5',
  modalDescPlaceholder: 'Hone 应该做什么？',
  modalCancel: '取消',
  modalTest: '🧪 测试运行',
  modalSave: '保存',
  modalTriggerCron: 'Cron 表达式',
  modalTriggerInterval: '间隔',
  modalTriggerOnce: '一次性',
  canvasRefresh: '↻ 刷新',
  canvasPopout: '↗ 弹出',
  canvasUpdated: '最后更新',
  canvasError: '⚠ 内容加载失败，请重试。',
  canvasRetry: '重试',
  canvasEmptyTitle: '还没有可视内容',
  canvasEmptyDesc: '对 Hone 说 "帮我画个架构图" 来开始。Hone 会实时生成可视化内容并展现在这里。',
  canvasEmptyHint: '"帮我画个架构图"',
  settingsProvider: '提供方',
  settingsGateway: '网关',
  settingsData: '数据',
  settingsAppearance: '外观',
  settingsAbout: '关于',
  setProviderTitle: '选择提供商',
  setProviderDesc: '选择 Hone 使用的 AI 推理后端。',
  setProviderLabel: '提供商',
  setApiKeyLabel: 'API Key',
  setApiKeyShow: '显示',
  setApiKeyHide: '隐藏',
  setModelLabel: '模型',
  setGatewayTitle: '网关配置',
  setGatewayDesc: '管理 Hone Relay 连接和本地端口。',
  setAutoStartLabel: '开机自启',
  setAutoStartDesc: '系统启动时自动运行 Hone 网关。',
  setRelayUrlLabel: '中继 URL',
  setPortLabel: '本地端口',
  setPortDesc: 'Hone Agent 用于本地通信的端口。',
  setDataTitle: '数据管理',
  setDataDesc: '工作区目录、日志保留期和数据清理。',
  setWorkspaceLabel: '工作区目录',
  setWorkspaceDesc: 'Hone 存储会话和输出的位置。',
  setLogRetentionLabel: '日志保留期',
  setClearDataLabel: '清除所有数据',
  setClearDataDesc: '删除所有会话记录、日程、设置和缓存。此操作不可撤销。',
  setClearDataBtn: '清除所有数据',
  setConfirmTitle: '确定要清除吗？',
  setConfirmBtn: '确认清除',
  setCancelBtn: '取消',
  setAppearanceTitle: '外观',
  setAppearanceDesc: '自定义 Hone 的视觉风格。',
  setVersionLabel: '版本',
  setUpdateBtn: '检查更新',
  setUpdated: '✓ 已是最新版',
  setDocsLink: '📖 查看文档',
  setLicenseLabel: '许可',
  gwTitle: 'Hone',
  gwOnline: '在线',
  gwThinking: '思考中…',
  gwOffline: '离线',
  gwStart: '启动',
  gwStop: '停止',
  gwStarting: '启动中…',
  gwStopping: '停止中…',
  gwSearch: '搜索对话…',
  gwPlaceholder: '对 Hone 说点什么…',
  gwSend: '发送',
  gwQuickDispatch: '派发到 CLI',
  gwQuickStatus: '查看状态',
  gwQuickSchedule: '查看日程',
  gwQuickCanvas: '打开画布',
  gwWelcome: '你好，我是 Hone。我 24 小时在线，可以帮你调度任务、监控机器、管理日程。需要我做什么？',
  gwMsg1: '今天早上 9:00 的代码审查已自动完成，3 个 PR 通过审查，0 个需要修改。',
  gwMsg2: '需要我帮你把这周的所有 PR 汇总成 changelog 吗？',
  gwMsg3: 'Server-DEV 的 token 用量接近上限（80%），建议调整 maxTokens 或升级计划。',
  gwConnected: '已连接到中继，Hone 就绪。有什么需要我帮你做的？',
  pairTitle: '连接 CLI 实例',
  pairDesc: '通过本地网络、SSH 或 Cloudflare Tunnel 连接运行 Hone Agent 的机器。',
  pairLocal: '本地网络',
  pairSSH: 'SSH 远程',
  pairTunnel: 'Cloudflare Tunnel',
  pairCode: '配对码',
  pairCodeDesc: '在目标机器上运行 hone pair 命令获取配对码。',
  pairCodePlaceholder: '输入 6 位配对码',
  pairHost: '主机地址',
  pairHostPlaceholder: '192.168.1.100 或 user@host',
  pairPort: '端口',
  pairConnect: '连接',
  pairConnecting: '连接中…',
  pairConnected: '已连接',
  pairFailed: '连接失败',
  pairCancel: '取消',
  skillsTitle: '技能管理',
  skillsDesc: '创建、编辑和管理 Hone 技能。技能是可在 CLI 中调用的专项能力模块。',
  skillsAdd: '+ 新建技能',
  skillEnabled: '已启用',
  skillDisabled: '已禁用',
  mcpTitle: 'MCP 服务器',
  mcpDesc: '管理 MCP（Model Context Protocol）服务器连接。MCP 让 Hone 访问外部工具和数据源。',
  mcpAdd: '+ 添加 MCP 服务器',
  mcpConnected: '已连接',
  mcpDisconnected: '未连接',
  mcpError: '连接失败',
  mcpConfigLabel: '配置',
  mcpToolsLabel: '工具数',
  // Browser
  tabWebtask: '网页任务',
  browserSettings: '浏览器',
  browserSettingsTitle: '浏览器自动化',
  browserSettingsDesc: '配置 Playwright 浏览器和 GUI 视觉模型，让 Hone 自动完成网页操作。',
  browserEnabledLabel: '启用浏览器代理',
  browserEnabledDesc: '开启后 Hone 可执行网页自动化任务。需要安装 Playwright。',
  browserGuiModelLabel: 'GUI 模型 URL',
  browserGuiModelDesc: '视觉模型 API 端点（OpenAI 兼容），留空则使用 DOM 降级模式。',
  browserHeadlessLabel: '无头模式',
  browserHeadlessDesc: '浏览器在后台运行，不显示窗口。关闭可观察自动操作过程。',
  browserMaxStepsLabel: '最大步数',
  browserMaxStepsDesc: '每个任务最多执行的浏览器操作步数。',
  webtaskTitle: '网页任务',
  webtaskDesc: '用自然语言描述网页操作，Hone 自动用浏览器完成。',
  webtaskInput: '描述你要做的网页操作…',
  webtaskUrl: '起始网址（可选）',
  webtaskSubmit: '执行',
  webtaskSubmitting: '执行中…',
  webtaskLowRisk: '低风险',
  webtaskMediumRisk: '中风险',
  webtaskHighRisk: '高风险',
  webtaskStep: '步',
  webtaskSteps: '步',
  webtaskSuccess: '任务完成',
  webtaskFailed: '任务失败',
  webtaskTimeout: '超时',
  webtaskCancelled: '已取消',
  webtaskEmpty: '还没有执行过网页任务',
  webtaskEmptyDesc: '让 Hone 自动打开网页、填写表单、发布内容。输入自然语言任务描述即可开始。',
  webtaskPlaceholder: '说说你想让 Hone 在网页上做什么…',
};

const en: Translations = {
  tabDashboard: 'Dashboard',
  tabGateway: 'Chat',
  tabSchedule: 'Schedule',
  tabWorkspace: 'Workspace',
  tabWatch: 'Watch',
  tabCanvas: 'Canvas',
  tabSettings: 'Settings',
  sidebarTitle: 'Machines',
  sidebarSessions: ' sessions',
  sidebarAdd: '+ Add Machine',
  sidebarLangToggle: '中',
  sidebarRelayActive: 'Relay active',
  statusOnline: 'Online',
  statusBusy: 'Busy',
  statusOffline: 'Offline',
  emptyTitle: 'No machines connected',
  emptyDesc: 'Connect a remote machine running Hone Agent to start managing AI coding assistants. Supports Linux, macOS, Windows.',
  emptyBtn: 'Add First Machine',
  loadingTitle: 'Loading…',
  loadingDesc: 'Connecting to Hone gateway…',
  errorTitle: 'Connection Failed',
  errorDesc: 'Unable to connect to Hone Relay. Check your network and gateway status.',
  errorBtn: 'Retry',
  cardsMachinesTitle: 'Machines Online',
  cardsMachinesDesc: '1 busy',
  cardsSessionsTitle: 'Active Sessions',
  cardsSessionsDesc: '4 live',
  cardsTokensTitle: 'Tokens Today',
  cardsTokensDesc: 'peak 2.8k',
  cardsTasksTitle: 'Scheduled Tasks',
  cardsTasksDesc: 'next 2:00',
  tableTitle: 'Sessions',
  tableColMachine: 'Machine',
  tableColStatus: 'Status',
  tableColTask: 'Task',
  tableColTokens: 'Token',
  tableColTime: 'Time',
  tableSearch: 'Search…',
  tableFilterAll: 'All',
  tableFilterLive: 'Live',
  tableFilterIdle: 'Idle',
  tableFilterDone: 'Done',
  badgeLive: 'Live',
  badgeIdle: 'Idle',
  badgeDone: 'Done',
  activityTitle: 'Recent Activity',
  statusUptime: 'Uptime',
  statusLatency: 'Latency',
  statusTokens: 'Tokens Today',
  statusBackup: 'Last Backup',
  schedEmptyTitle: 'No schedules yet',
  schedEmptyDesc: 'Let Hone do the work on autopilot. Describe the task you want to run regularly in natural language, and AI will parse it into a schedule.',
  schedEmptyBtn: 'Create Schedule',
  schedCardNext: 'Next',
  schedCardSuccess: '✓ Success',
  schedCardFail: '✗ Failed',
  schedNewBtn: '+ New Schedule',
  schedFilterAll: 'All',
  schedFilterActive: 'Active',
  schedFilterPaused: 'Paused',
  schedFilterCompleted: 'Completed',
  schedSearchPlaceholder: 'Search schedules…',
  aiTitle: '✨ Hone noticed a pattern',
  aiDismiss: 'Dismiss',
  modalNewTitle: 'New Schedule',
  modalEditTitle: 'Edit Schedule',
  modalNLLabel: 'Natural Language',
  modalTriggerLabel: 'Trigger Type',
  modalTimeLabel: 'Time / Cron',
  modalDescLabel: 'Task Description',
  modalDeliveryLabel: 'Delivery',
  modalDeliveryDesktop: 'Desktop',
  modalDeliveryCli: 'CLI',
  modalDeliverySession: 'Session',
  modalNLPlaceholder: 'e.g., Check my GitHub PRs every morning at 9am',
  modalTimePlaceholder: '0 9 * * 1-5',
  modalDescPlaceholder: 'What should Hone do?',
  modalCancel: 'Cancel',
  modalTest: '🧪 Test Run',
  modalSave: 'Save',
  modalTriggerCron: 'Cron Expression',
  modalTriggerInterval: 'Interval',
  modalTriggerOnce: 'One-time',
  canvasRefresh: '↻ Refresh',
  canvasPopout: '↗ Pop-out',
  canvasUpdated: 'Updated',
  canvasError: '⚠ Content failed to load, please retry.',
  canvasRetry: 'Retry',
  canvasEmptyTitle: 'No visual content yet',
  canvasEmptyDesc: 'Tell Hone "Draw me an architecture diagram" to get started. Hone generates visualizations in real time and displays them here.',
  canvasEmptyHint: '"Draw me an architecture diagram"',
  settingsProvider: 'Provider',
  settingsGateway: 'Gateway',
  settingsData: 'Data',
  settingsAppearance: 'Appearance',
  settingsAbout: 'About',
  setProviderTitle: 'Choose Provider',
  setProviderDesc: 'Select the AI inference backend for Hone.',
  setProviderLabel: 'Provider',
  setApiKeyLabel: 'API Key',
  setApiKeyShow: 'Show',
  setApiKeyHide: 'Hide',
  setModelLabel: 'Model',
  setGatewayTitle: 'Gateway Config',
  setGatewayDesc: 'Manage Hone Relay connection and local port.',
  setAutoStartLabel: 'Auto-start on boot',
  setAutoStartDesc: 'Launch Hone gateway automatically on system startup.',
  setRelayUrlLabel: 'Relay URL',
  setPortLabel: 'Local Port',
  setPortDesc: 'Port used by Hone Agent for local communication.',
  setDataTitle: 'Data Management',
  setDataDesc: 'Workspace directory, log retention, and data cleanup.',
  setWorkspaceLabel: 'Workspace Directory',
  setWorkspaceDesc: 'Where Hone stores sessions and output.',
  setLogRetentionLabel: 'Log Retention',
  setClearDataLabel: 'Clear All Data',
  setClearDataDesc: 'Delete all sessions, schedules, settings, and cache. This cannot be undone.',
  setClearDataBtn: 'Clear All Data',
  setConfirmTitle: 'Are you sure?',
  setConfirmBtn: 'Confirm Clear',
  setCancelBtn: 'Cancel',
  setAppearanceTitle: 'Appearance',
  setAppearanceDesc: 'Customize how Hone looks.',
  setVersionLabel: 'Version',
  setUpdateBtn: 'Check for Updates',
  setUpdated: '✓ Up to date',
  setDocsLink: '📖 View Docs',
  setLicenseLabel: 'License',
  gwTitle: 'Hone',
  gwOnline: 'Online',
  gwThinking: 'Thinking…',
  gwOffline: 'Offline',
  gwStart: 'Start',
  gwStop: 'Stop',
  gwStarting: 'Starting…',
  gwStopping: 'Stopping…',
  gwSearch: 'Search chat…',
  gwPlaceholder: 'Message Hone…',
  gwSend: 'Send',
  gwQuickDispatch: 'Dispatch to CLI',
  gwQuickStatus: 'Check Status',
  gwQuickSchedule: 'View Schedules',
  gwQuickCanvas: 'Open Canvas',
  gwWelcome: "Hi, I'm Hone. I'm online 24/7, ready to schedule tasks, monitor machines, and manage your workflow. What can I do for you?",
  gwMsg1: "Today's 9:00 AM code review completed automatically — 3 PRs passed, 0 need changes.",
  gwMsg2: 'Would you like me to compile all this week\'s PRs into a changelog?',
  gwMsg3: 'Server-DEV token usage is approaching the limit (80%), consider adjusting maxTokens or upgrading your plan.',
  gwConnected: 'Connected to relay, Hone is ready. What can I do for you?',
  pairTitle: 'Connect CLI Instance',
  pairDesc: 'Connect a machine running Hone Agent via local network, SSH, or Cloudflare Tunnel.',
  pairLocal: 'Local Network',
  pairSSH: 'SSH Remote',
  pairTunnel: 'Cloudflare Tunnel',
  pairCode: 'Pairing Code',
  pairCodeDesc: "Run 'hone pair' on the target machine to get a pairing code.",
  pairCodePlaceholder: 'Enter 6-digit code',
  pairHost: 'Host Address',
  pairHostPlaceholder: '192.168.1.100 or user@host',
  pairPort: 'Port',
  pairConnect: 'Connect',
  pairConnecting: 'Connecting…',
  pairConnected: 'Connected',
  pairFailed: 'Connection Failed',
  pairCancel: 'Cancel',
  skillsTitle: 'Skills',
  skillsDesc: 'Create, edit, and manage Hone skills. Skills are specialized capability modules callable from the CLI.',
  skillsAdd: '+ New Skill',
  skillEnabled: 'Enabled',
  skillDisabled: 'Disabled',
  mcpTitle: 'MCP Servers',
  mcpDesc: 'Manage MCP (Model Context Protocol) server connections. MCP gives Hone access to external tools and data sources.',
  mcpAdd: '+ Add MCP Server',
  mcpConnected: 'Connected',
  mcpDisconnected: 'Disconnected',
  mcpError: 'Connection Error',
  mcpConfigLabel: 'Config',
  mcpToolsLabel: 'Tools',
  // Browser
  tabWebtask: 'Web Tasks',
  browserSettings: 'Browser',
  browserSettingsTitle: 'Browser Automation',
  browserSettingsDesc: 'Configure Playwright browser and GUI vision model for autonomous web tasks.',
  browserEnabledLabel: 'Enable Browser Agent',
  browserEnabledDesc: 'When enabled, Hone can execute web automation tasks. Requires Playwright.',
  browserGuiModelLabel: 'GUI Model URL',
  browserGuiModelDesc: 'Vision model API endpoint (OpenAI-compatible). Leave empty for DOM fallback mode.',
  browserHeadlessLabel: 'Headless Mode',
  browserHeadlessDesc: 'Run browser in background. Disable to watch automation in action.',
  browserMaxStepsLabel: 'Max Steps',
  browserMaxStepsDesc: 'Maximum browser actions per task.',
  webtaskTitle: 'Web Tasks',
  webtaskDesc: 'Describe a web task in natural language. Hone will execute it autonomously.',
  webtaskInput: 'Describe what to do on the web…',
  webtaskUrl: 'Starting URL (optional)',
  webtaskSubmit: 'Run',
  webtaskSubmitting: 'Running…',
  webtaskLowRisk: 'Low Risk',
  webtaskMediumRisk: 'Medium Risk',
  webtaskHighRisk: 'High Risk',
  webtaskStep: 'step',
  webtaskSteps: 'steps',
  webtaskSuccess: 'Task completed',
  webtaskFailed: 'Task failed',
  webtaskTimeout: 'Timed out',
  webtaskCancelled: 'Cancelled',
  webtaskEmpty: 'No web tasks run yet',
  webtaskEmptyDesc: 'Let Hone browse the web, fill forms, and post content. Describe what you need in natural language.',
  webtaskPlaceholder: 'Tell Hone what to do on the web…',
};

export const LANG: Record<Lang, Translations> = { zh, en };
