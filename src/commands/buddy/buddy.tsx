import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { useSetAppState } from '../../state/AppState.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { getCompanion, companionUserId, roll } from '../../buddy/companion.js'
import { RARITY_COLORS, RARITY_STARS } from '../../buddy/types.js'
import { renderFace } from '../../buddy/sprites.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { LocalJSXCommandContext } from '../../commands.js'

function Buddy({ args, onDone }: { args: string[]; onDone: LocalJSXCommandOnDone }) {
  const companion = getCompanion()
  const setAppState = useSetAppState()
  const [message, setMessage] = useState('')

  useEffect(() => {
    const sub = args[0]
    if (sub === 'pet') {
      if (!companion) {
        setMessage('你还没有同伴！先运行 /buddy 孵化一个吧。')
        return
      }
      setAppState(prev => ({ ...prev, companionPetAt: Date.now() }))
      setMessage(`你摸了一下 ${companion.name}！它看起来很开心的样子。`)
      return
    }

    if (sub === 'rename') {
      if (!companion) {
        setMessage('你还没有同伴！先运行 /buddy 孵化一个吧。')
        return
      }
      const newName = args.slice(1).join(' ')
      if (!newName) {
        setMessage('请提供新名字: /buddy rename <名字>')
        return
      }
      saveGlobalConfig(config => ({
        ...config,
        companion: {
          ...config.companion!,
          name: newName
        }
      }))
      setMessage(`你的同伴现在叫 ${newName}！`)
      return
    }

    if (!companion) {
      const userId = companionUserId()
      const { bones } = roll(userId)
      const newCompanion = {
        name: '小石',
        personality: '你编程旅程中的忠实同伴。',
        hatchedAt: Date.now(),
      }
      saveGlobalConfig(config => ({
        ...config,
        companion: newCompanion
      }))
      setMessage(`一个同伴孵化出来了！来认识一下 ${newCompanion.name}。`)
    } else {
      setMessage(`用 /buddy pet 摸摸 ${companion.name}，或 /buddy rename 给它改名。`)
    }
  }, [args, companion, setAppState])

  useInput((_input, key) => {
    if (key) onDone()
  })

  return (
    <Box flexDirection="column" padding={1}>
      {companion && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={RARITY_COLORS[companion.rarity]}>
            {renderFace(companion)} {companion.name}
          </Text>
          <Text dimColor>
            {companion.rarity.toUpperCase()} {RARITY_STARS[companion.rarity]}
          </Text>
          <Text italic>{companion.personality}</Text>
        </Box>
      )}
      <Text>{message}</Text>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const parsedArgs = args.trim() ? args.trim().split(/\s+/) : []
  return <Buddy args={parsedArgs} onDone={onDone} />
}
