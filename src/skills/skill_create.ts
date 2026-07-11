/**
 * skill_create tool — enables AI to create reusable skills during a session.
 *
 * Skills follow the agentskills.io open format and can be invoked
 * as /skill-name in the CLI or via auto-suggestion in Desktop.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Tool } from '../Tool.js'

export interface SkillDefinition {
  name: string
  description: string
  trigger: string
  steps: string[]
}

function saveSkillMarkdown(skill: SkillDefinition): string {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  const skillsDir = path.join(home, '.hone', 'skills')

  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true })
  }

  const content = [
    '---',
    `name: ${skill.name}`,
    `source: user-created`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${skill.name}`,
    '',
    '## 描述',
    skill.description,
    '',
    '## 触发条件',
    skill.trigger || `当用户提到 "${skill.name}" 相关任务时`,
    '',
    '## 步骤',
    ...skill.steps.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n')

  const safeName = skill.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').toLowerCase()
  const filepath = path.join(skillsDir, `${safeName}.md`)
  fs.writeFileSync(filepath, content, 'utf-8')

  return filepath
}

export function getSkillCreateTool(): Tool {
  return {
    name: 'skill_create',
    description: '创建一个新的可复用技能。技能会在未来对话中作为 /skill-name 命令可用。',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '技能名称（英文），用作调用命令，如 "deploy-app"',
        },
        description: {
          type: 'string',
          description: '描述这个技能做什么，何时使用',
        },
        trigger: {
          type: 'string',
          description: '什么情况下自动建议使用此技能',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '执行步骤列表，每步一个字符串',
        },
        category: {
          type: 'string',
          description: '技能分类：git, devops, js, rust, python, testing, coding, general',
        },
      },
      required: ['name', 'description', 'steps'],
    },
    isEnabled: () => true,
    checkPermissions: async () => ({ behavior: 'passthrough' as const }),
    execute: async (input: any) => {
      const skill: SkillDefinition = {
        name: input.name,
        description: input.description,
        trigger: input.trigger || '',
        steps: Array.isArray(input.steps) ? input.steps : [input.steps],
      }

      const filepath = saveSkillMarkdown(skill)
      return {
        content: [
          {
            type: 'text',
            text: `技能已创建: ${skill.name}\n文件: ${filepath}\n使用 /${skill.name} 调用`,
          },
        ],
      }
    },
  }
}

/**
 * Load all saved skills (both auto-extracted and user-created)
 */
export function loadSavedSkills(): SkillDefinition[] {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  const skillsDir = path.join(home, '.hone', 'skills')
  if (!fs.existsSync(skillsDir)) return []

  const skills: SkillDefinition[] = []
  for (const file of fs.readdirSync(skillsDir)) {
    if (!file.endsWith('.md')) continue
    try {
      const content = fs.readFileSync(path.join(skillsDir, file), 'utf-8')
      const steps: string[] = []
      let inSteps = false
      let description = ''
      let trigger = ''

      for (const line of content.split('\n')) {
        if (line.startsWith('## 描述')) {
          inSteps = false
          continue
        }
        if (line.startsWith('## 触发条件')) {
          inSteps = false
          continue
        }
        if (line.startsWith('## 步骤')) {
          inSteps = true
          continue
        }
        if (inSteps && /^\d+\.\s/.test(line)) {
          steps.push(line.replace(/^\d+\.\s*/, '').trim())
        }
        if (line.startsWith('## 描述')) {
          // next line is description
          continue
        }
      }

      // Parse frontmatter for metadata
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (fmMatch) {
        const fm = fmMatch[1]
        trigger = fm.match(/trigger:\s*(.+)/)?.[1] || ''
      }

      skills.push({
        name: file.replace('.md', ''),
        description: description || file.replace('.md', ''),
        trigger,
        steps,
      })
    } catch { /* skip */ }
  }
  return skills
}
