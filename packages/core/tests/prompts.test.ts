import { describe, expect, test } from 'vitest'
import { buildTurnPrompt, TURN_PROMPT_VERSION } from '../src/prompts/summarize-turn.ts'
import { buildSessionPrompt, SESSION_PROMPT_VERSION } from '../src/prompts/summarize-session.ts'

describe('buildTurnPrompt', () => {
  const built = buildTurnPrompt({
    transcript: 'user: 把 store.ts 的超时改成 500ms\nassistant: 改好了',
    occurredAt: Date.UTC(2026, 8, 5, 8, 0),
    cwd: '/work/dsh-memgas',
    gitBranch: 'main',
  })

  test('puts the transcript and its context in the user turn, not the system prompt', () => {
    expect(built.prompt).toContain('store.ts 的超时改成 500ms')
    expect(built.prompt).toContain('/work/dsh-memgas')
    expect(built.prompt).toContain('main')
    expect(built.system).not.toContain('store.ts')
  })

  test('states the empty-output escape hatch and the secret exclusion', () => {
    expect(built.system).toContain('"facts":[]')
    expect(built.system).toMatch(/密钥|token|密码/)
  })

  test('is versioned so stored memories can be traced to the prompt that made them', () => {
    expect(TURN_PROMPT_VERSION).toMatch(/^summarize-turn@\d+$/)
    expect(built.version).toBe(TURN_PROMPT_VERSION)
  })
})

describe('buildSessionPrompt', () => {
  test('feeds every turn summary and asks for session-level facts only', () => {
    const built = buildSessionPrompt({
      turnSummaries: ['第一轮：改超时', '第二轮：加测试'],
      occurredAt: Date.UTC(2026, 8, 5, 8, 0),
    })
    expect(built.prompt).toContain('第一轮：改超时')
    expect(built.prompt).toContain('第二轮：加测试')
    expect(built.version).toBe(SESSION_PROMPT_VERSION)
  })
})
