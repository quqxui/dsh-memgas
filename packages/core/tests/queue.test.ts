import { describe, expect, test } from 'vitest'
import { BackgroundQueue } from '../src/queue.ts'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('BackgroundQueue', () => {
  test('runs jobs one at a time in the order they were queued', async () => {
    const queue = new BackgroundQueue({ jobTimeoutMs: 1000 })
    const order: string[] = []
    queue.enqueue('a', async () => { await tick(10); order.push('a') })
    queue.enqueue('b', async () => { order.push('b') })
    await queue.idle()
    expect(order).toEqual(['a', 'b'])
  })

  test('records a failure and keeps draining after a job throws', async () => {
    const queue = new BackgroundQueue({ jobTimeoutMs: 1000 })
    const ran: string[] = []
    queue.enqueue('bad', async () => { throw new Error('llm unavailable') })
    queue.enqueue('good', async () => { ran.push('good') })
    await queue.idle()
    expect(ran).toEqual(['good'])
    const stats = queue.stats()
    expect(stats.failed).toBe(1)
    expect(stats.done).toBe(1)
    expect(stats.lastError).toMatchObject({ name: 'bad', reason: 'llm unavailable' })
  })

  test('aborts a job that overruns its timeout and moves on', async () => {
    const queue = new BackgroundQueue({ jobTimeoutMs: 20 })
    let aborted = false
    queue.enqueue('slow', async signal => {
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => { aborted = true; resolve() })
        setTimeout(resolve, 500)
      })
    })
    queue.enqueue('next', async () => {})
    await queue.idle()
    expect(aborted).toBe(true)
    expect(queue.stats().lastError?.reason).toContain('timeout')
    expect(queue.stats().done).toBe(1)
  })

  test('reports pending and running counts while work is in flight', async () => {
    const queue = new BackgroundQueue({ jobTimeoutMs: 1000 })
    let release!: () => void
    queue.enqueue('hold', () => new Promise<void>(resolve => { release = resolve }))
    queue.enqueue('wait', async () => {})
    await tick(5)
    expect(queue.stats()).toMatchObject({ running: 1, pending: 1 })
    release()
    await queue.idle()
    expect(queue.stats()).toMatchObject({ running: 0, pending: 0, done: 2 })
  })

  test('idle resolves immediately when nothing was queued', async () => {
    const queue = new BackgroundQueue({ jobTimeoutMs: 1000 })
    await expect(queue.idle()).resolves.toBeUndefined()
  })
})
