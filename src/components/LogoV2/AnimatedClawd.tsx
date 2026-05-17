import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box } from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { Clawd, type ClawdPose } from './Clawd.js'

type Frame = { pose: ClawdPose; offset: number }

const FRAME_MS = 100
const CLAWD_HEIGHT = 4

/** Hold a pose for n frames (60ms each). */
function hold(pose: ClawdPose, offset: number, frames: number): Frame[] {
  return Array.from({ length: frames }, () => ({ pose, offset }))
}

// Jump: sink (offset=2 hides feet+body), spring up with happy eyes, land. Twice.
const JUMP_WAVE: readonly Frame[] = [
  ...hold('default', 1, 3),   // sink 1
  ...hold('default', 2, 3),   // sink 2 (deeper crouch)
  ...hold('arms-up', 0, 5),   // spring! (happy squint)
  ...hold('default', 0, 4),   // land, pause
  ...hold('default', 1, 3),   // sink 1 again
  ...hold('default', 2, 3),   // sink 2
  ...hold('arms-up', 0, 5),   // spring!
  ...hold('default', 0, 4),   // land
]

// Look around: glance right, then left, then back.
const LOOK_AROUND: readonly Frame[] = [
  ...hold('look-right', 0, 8),
  ...hold('look-left', 0, 8),
  ...hold('default', 0, 6),
]

const ANIMATIONS: readonly (readonly Frame[])[] = [LOOK_AROUND, JUMP_WAVE]

const IDLE: Frame = { pose: 'default' as ClawdPose, offset: 0 }

/**
 * Clawd with auto-playing idle animations (jump, look-around).
 * Also responds to clicks in fullscreen mode.
 */
export function AnimatedClawd(): React.ReactNode {
  const { pose, bounceOffset, onClick } = useClawdAnimation()
  return (
    <Box height={CLAWD_HEIGHT} flexDirection="column" onClick={onClick}>
      <Box marginTop={bounceOffset} flexShrink={0}>
        <Clawd pose={pose} />
      </Box>
    </Box>
  )
}

function useClawdAnimation(): {
  pose: ClawdPose
  bounceOffset: number
  onClick: () => void
} {
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  const [frameIndex, setFrameIndex] = useState(-1)
  const sequenceRef = useRef<readonly Frame[]>(JUMP_WAVE)
  const nextAnimRef = useRef(0)

  const startAnimation = (seq: readonly Frame[]) => {
    sequenceRef.current = seq
    setFrameIndex(0)
  }

  const pickNextAnimation = (): readonly Frame[] => {
    const anim = ANIMATIONS[nextAnimRef.current]!
    nextAnimRef.current = (nextAnimRef.current + 1) % ANIMATIONS.length
    return anim
  }

  const onClick = () => {
    if (reducedMotion || frameIndex !== -1) return
    startAnimation(pickNextAnimation())
  }

  // Auto-play on mount — always start with LOOK_AROUND so user sees it
  useEffect(() => {
    if (reducedMotion) return
    const initialDelay = setTimeout(() => {
      startAnimation(pickNextAnimation())
    }, 1500 + Math.random() * 2000)
    return () => clearTimeout(initialDelay)
  }, [reducedMotion])

  // Periodic auto-play
  useEffect(() => {
    if (reducedMotion) return
    if (frameIndex === -1) {
      const t = setTimeout(() => {
        startAnimation(pickNextAnimation())
      }, 8000 + Math.random() * 10000)
      return () => clearTimeout(t)
    }
  }, [frameIndex, reducedMotion])

  // Frame timer
  useEffect(() => {
    if (frameIndex === -1) return
    if (frameIndex >= sequenceRef.current.length) {
      setFrameIndex(-1)
      return
    }
    const timer = setTimeout(() => setFrameIndex(i => i + 1), FRAME_MS)
    return () => clearTimeout(timer)
  }, [frameIndex])

  const seq = sequenceRef.current
  const current = frameIndex >= 0 && frameIndex < seq.length ? seq[frameIndex]! : IDLE
  return { pose: current.pose, bounceOffset: current.offset, onClick }
}
