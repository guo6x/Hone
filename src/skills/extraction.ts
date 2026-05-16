/**
 * Skill extraction — automatically extract reusable skills from completed tasks.
 *
 * When an AI session completes a complex, multi-step task successfully,
 * this module extracts the workflow into a reusable SKILL.md entry.
 *
 * Skill format is compatible with agentskills.io open standard:
 * ```markdown
 * # <skill-name>
 * ## 描述
 * <when to use>
 * ## 触发条件
 * <when to auto-suggest>
 * ## 步骤
 * 1. ...
 * 2. ...
 * ```
 */

import * as fs from 'fs'
import * as path from 'path'

// ── Types ──

export interface SkillTemplate {
  name: string
  description: string
  trigger: string
  steps: string[]
  category: string
}

export interface ExtractedSkill {
  template: SkillTemplate
  source: string // which task/conversation it came from
  confidence: number
}

// ── Skill extraction heuristics ──

/**
 * Determine if a task is "complex enough" to extract as a skill.
 * Complexity heuristics:
 * - Used 3+ different tools
 * - Involved 5+ distinct actions
 * - Took more than 2 minutes
 * - Resulted in a successful outcome
 */
function isComplexTask(actions: {
  tools: string[]
  steps: number
  durationMs: number
  success: boolean
}): boolean {
  const uniqueTools = new Set(actions.tools).size
  return (
    uniqueTools >= 3 &&
    actions.steps >= 5 &&
    actions.durationMs > 120_000 &&
    actions.success
  )
}

/**
 * Categorize a task based on tools used
 */
function categorizeTask(tools: string[]): string {
  const toolSet = new Set(tools)
  if (toolSet.has('git') || toolSet.has('gh')) return 'git'
  if (toolSet.has('docker') || toolSet.has('kubectl')) return 'devops'
  if (toolSet.has('npm') || toolSet.has('yarn') || toolSet.has('pnpm')) return 'js'
  if (toolSet.has('cargo') || toolSet.has('rustc')) return 'rust'
  if (toolSet.has('python') || toolSet.has('pip')) return 'python'
  if (toolSet.has('write') || toolSet.has('edit')) {
    if (toolSet.has('test') || toolSet.has('jest') || toolSet.has('vitest')) return 'testing'
    return 'coding'
  }
  return 'general'
}

/**
 * Generate a skill name from the task description
 */
function generateName(taskDescription: string): string {
  // Take first 3-4 meaningful words, lowercase, replace spaces with hyphens
  const cleaned = taskDescription
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
    .toLowerCase()
  return cleaned || 'untitled-skill'
}

/**
 * Extract key steps from a sequence of actions
 */
function extractSteps(actions: string[], context: string): string[] {
  // Group similar actions, keep only distinct steps
  const distinct: string[] = []
  for (const action of actions) {
    const normalized = action.trim().replace(/\s+/g, ' ')
    if (normalized.length > 0 && !distinct.includes(normalized)) {
      distinct.push(normalized)
    }
  }
  return distinct.slice(0, 10) // max 10 steps
}

// ── Main extraction ──

export function extractSkill(
  taskDescription: string,
  actions: string[],
  context: string,
  metrics: {
    tools: string[]
    steps: number
    durationMs: number
    success: boolean
  },
): ExtractedSkill | null {
  if (!isComplexTask(metrics)) return null

  const category = categorizeTask(metrics.tools)
  const name = generateName(taskDescription)
  const steps = extractSteps(actions, context)

  const description = [
    `从以下任务自动化提取: ${taskDescription}`,
    '',
    `## 描述`,
    `根据之前执行过的流程自动生成的技能。用于: ${taskDescription}`,
    '',
    `## 触发条件`,
    `当用户提到 "${taskDescription.slice(0, 50)}" 或类似任务时建议此技能`,
    '',
    `## 步骤`,
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n')

  return {
    template: {
      name,
      description,
      trigger: taskDescription.slice(0, 100),
      steps,
      category,
    },
    source: taskDescription,
    confidence: Math.min(0.9, metrics.steps / 10 + metrics.durationMs / 300000),
  }
}

// ── Save extracted skill ──

export function saveSkill(skill: ExtractedSkill): string {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  const skillsDir = path.join(home, '.hone', 'skills')

  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true })
  }

  const content = [
    '---',
    `name: ${skill.template.name}`,
    `category: ${skill.template.category}`,
    `source: auto-extracted`,
    `confidence: ${skill.confidence.toFixed(2)}`,
    '---',
    '',
    skill.template.description,
  ].join('\n')

  const filepath = path.join(skillsDir, `${skill.template.name}.md`)
  fs.writeFileSync(filepath, content, 'utf-8')

  console.error(`[Skills] 已自动提取技能: ${skill.template.name} (置信度: ${(skill.confidence * 100).toFixed(0)}%)`)

  return filepath
}

/**
 * Check if a similar skill already exists
 */
export function hasExistingSkill(name: string): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  const skillsDir = path.join(home, '.hone', 'skills')
  if (!fs.existsSync(skillsDir)) return false

  const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').toLowerCase()
  return fs.existsSync(path.join(skillsDir, `${safeName}.md`))
}

/**
 * List all auto-extracted skills
 */
export function listExtractedSkills(): SkillTemplate[] {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  const skillsDir = path.join(home, '.hone', 'skills')
  if (!fs.existsSync(skillsDir)) return []

  const skills: SkillTemplate[] = []
  for (const file of fs.readdirSync(skillsDir)) {
    if (!file.endsWith('.md')) continue
    try {
      const content = fs.readFileSync(path.join(skillsDir, file), 'utf-8')
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue
      const fm = fmMatch[1]
      if (!fm.includes('source: auto-extracted')) continue

      skills.push({
        name: file.replace('.md', ''),
        description: content.replace(/^---[\s\S]*?---\n*/, '').trim(),
        trigger: '',
        steps: [],
        category: fm.match(/category:\s*(.+)/)?.[1] || 'general',
      })
    } catch { /* skip */ }
  }
  return skills
}
