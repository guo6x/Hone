import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { env } from '../../utils/env.js'

export type ClawdPose =
  | 'default'
  | 'arms-up'   // both arms raised (used during jump)
  | 'look-left' // both pupils shifted left
  | 'look-right' // both pupils shifted right

type Props = {
  pose?: ClawdPose
}

// 小石 (xiaoshi) — stone-shaped mascot for Hone.
// 4 rows: head top, eyes, body, feet. 8 cols wide.
//
// arms-up: body borders switch from ▐/▌ to ▗/▖ (raised arms).
// look-* use top-quadrant eye chars (▙/▟) for directional pupils.
type Segments = {
  /** row 1 left (no bg): side + optional arm */
  r1L: string
  /** row 1 eyes (with bg): left-eye, forehead, right-eye */
  r1E: string
  /** row 1 right (no bg): side + optional arm */
  r1R: string
  /** row 2 left (no bg): body left edge */
  r2L: string
  /** row 2 right (no bg): body right edge */
  r2R: string
}

const POSES: Record<ClawdPose, Segments> = {
  default: {
    r1L: ' ▐',
    r1E: '▛███▜',
    r1R: '▌',
    r2L: '▐',
    r2R: '▌'
  },
  'look-left': {
    r1L: ' ▐',
    r1E: '▐███▐',
    r1R: '▌',
    r2L: '▐',
    r2R: '▌'
  },
  'look-right': {
    r1L: ' ▐',
    r1E: '▌███▌',
    r1R: '▌',
    r2L: '▐',
    r2R: '▌'
  },
  'arms-up': {
    r1L: '▗ ',
    r1E: '▀███▀',
    r1R: ' ▖',
    r2L: '▗',
    r2R: '▖'
  },
}

// Apple Terminal bg-fill trick — eyes only, arms fall to default.
const APPLE_EYES: Record<ClawdPose, string> = {
  default: ' ▛   ▜ ',
  'look-left': ' ▐   ▐ ',
  'look-right': ' ▌   ▌ ',
  'arms-up': ' ▀   ▀ ',
}

const HEAD_TOP = '  ▗▄▄▄▄▖'
const BODY_BG = '██████'
const FEET = '  ▀▀▀▀▀▀'

export function Clawd({ pose = 'default' }: Props = {}): React.ReactNode {
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalClawd pose={pose} />
  }
  const p = POSES[pose]
  return (
    <Box flexDirection="column">
      <Text color="clawd_body">{HEAD_TOP}</Text>
      <Text>
        <Text color="clawd_body">{p.r1L}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">
          {p.r1E}
        </Text>
        <Text color="clawd_body">{p.r1R}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{p.r2L}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">
          {BODY_BG}
        </Text>
        <Text color="clawd_body">{p.r2R}</Text>
      </Text>
      <Text color="clawd_body">{FEET}</Text>
    </Box>
  )
}

function AppleTerminalClawd({ pose }: { pose: ClawdPose }): React.ReactNode {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="clawd_body">  ▗▄▄▄▄▖</Text>
      <Text>
        <Text color="clawd_body">▗</Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {APPLE_EYES[pose]}
        </Text>
        <Text color="clawd_body">▖</Text>
      </Text>
      <Text backgroundColor="clawd_body">{' '.repeat(8)}</Text>
      <Text color="clawd_body">▀▀▀▀▀▀</Text>
    </Box>
  )
}
