/**
 * canvas_write tool - AI calls this to write HTML content to Canvas and trigger browser refresh.
 */
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { buildTool, type ToolDef } from '../Tool.js'
import { reloadCanvas } from './server.js'
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

const CANVAS_DIR = (process.env.HOME || '~') + '/.hone/canvas'

const inputSchema = lazySchema(() =>
  z.strictObject({
    sessionId: z
      .string()
      .describe('Current session ID for isolating canvas files'),
    filename: z
      .string()
      .optional()
      .describe('Filename (default: index.html)'),
    content: z
      .string()
      .describe('HTML content to write (full HTML file)'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

export const CanvasWriteTool = buildTool({
  name: 'canvas_write',
  searchHint: 'write HTML charts to browser for live preview',
  aliases: [],
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return process.env.USER_TYPE === 'hone' || process.env.HONE_GOD_MODE === '1' || process.env.HONE_ENABLE_CANVAS === '1'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async description() {
    return 'Write HTML content to Canvas and display in browser in real-time. Use for generating visualization charts, code relationship diagrams, flame graphs, etc. Default filename is index.html.'
  },
  async prompt() {
    return 'Use this tool to generate HTML/CSS/JS visualizations and preview them in the browser in real-time.'
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  async call({ sessionId, filename, content }, _context) {
    const fn = filename || 'index.html'
    const dir = join(CANVAS_DIR, sessionId)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, fn)
    await writeFile(filePath, content, 'utf-8')

    reloadCanvas(sessionId)

    const port = process.env.HONE_CANVAS_PORT || '9120'
    const url = 'http://localhost:' + port + '/' + sessionId + '/' + fn
    return {
      data: {
        url,
        filePath,
        bytes: content.length,
      },
    }
  },
} satisfies ToolDef<InputSchema, { url: string; filePath: string; bytes: number }>)
