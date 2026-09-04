import { describe, expect, test } from 'vitest'
import { normalizeGitRemote, projectKeyFor, GLOBAL_SCOPE } from '../src/scope.ts'

describe('normalizeGitRemote', () => {
  test('ssh and https forms of the same repo normalize to one key', () => {
    expect(normalizeGitRemote('git@github.com:xuderong/dsh-memgas.git'))
      .toBe(normalizeGitRemote('https://github.com/xuderong/dsh-memgas'))
  })

  test('drops credentials, port and case differences', () => {
    expect(normalizeGitRemote('https://user:token@GitHub.com:443/Xuderong/DSH-MemGAS.git'))
      .toBe('github.com/xuderong/dsh-memgas')
  })

  test('returns null when there is no usable remote', () => {
    expect(normalizeGitRemote('   ')).toBeNull()
  })
})

describe('projectKeyFor', () => {
  test('uses the normalized remote when one exists', () => {
    expect(projectKeyFor({ gitRemote: 'git@github.com:a/b.git', cwd: '/tmp/x' }))
      .toBe('project:github.com/a/b')
  })

  test('falls back to a key derived from cwd, stable across calls', () => {
    const first = projectKeyFor({ gitRemote: null, cwd: '/Users/me/code/thing' })
    const second = projectKeyFor({ gitRemote: null, cwd: '/Users/me/code/thing' })
    expect(first).toBe(second)
    expect(first).toMatch(/^project:cwd\/thing-[0-9a-f]{8}$/)
  })

  test('different directories sharing a basename get different keys', () => {
    expect(projectKeyFor({ gitRemote: null, cwd: '/Users/me/a/thing' }))
      .not.toBe(projectKeyFor({ gitRemote: null, cwd: '/Users/me/b/thing' }))
  })

  test('the global scope is a distinct constant', () => {
    expect(GLOBAL_SCOPE).toBe('global')
  })
})
