import type { HarvestEvent } from '@memgas/core'

export interface ModelRoute {
  provider: string
  model: string
}

/** The slice of dsh's session log envelope this plugin reads. */
export interface SessionEventLike {
  type: string
  data: unknown
}

interface TextBlockLike {
  type: string
  text?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return (blocks as TextBlockLike[])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Projects dsh session events onto the harness-neutral events the harvester
 * consumes, keeping the per-session turn counter and model route that the raw
 * events do not carry on every record.
 */
export class SessionEventMapper {
  private readonly turns = new Map<string, number>()
  private readonly routes = new Map<string, ModelRoute>()
  private last: ModelRoute | null = null
  /** Called whenever a new route is seen, so it can outlive the process. */
  constructor(private readonly onRoute?: (route: ModelRoute) => void) {}

  routeFor(sessionId: string): ModelRoute | null {
    return this.routes.get(sessionId) ?? null
  }

  /** The most recent route from any session; used before a session has one. */
  latestRoute(): ModelRoute | null {
    return this.last
  }

  map(sessionId: string, event: SessionEventLike): HarvestEvent | null {
    const data = event.data
    if (!isRecord(data)) return null
    const turn = typeof data['turn'] === 'number' ? data['turn'] : (this.turns.get(sessionId) ?? 0)

    switch (event.type) {
      case 'turn/start':
        this.turns.set(sessionId, turn)
        return null
      case 'user/message': {
        const source = data['source']
        // Only what the human typed is memory material; plugin notices and
        // our own recall cards would otherwise be summarized back into the store.
        if (!isRecord(source) || source['kind'] !== 'user') return null
        const text = textOf(data['content'])
        return text ? { type: 'user', turn, text } : null
      }
      case 'assistant/message': {
        const message = data['message']
        const text = isRecord(message) ? textOf(message['content']) : ''
        return text ? { type: 'assistant', turn, text } : null
      }
      case 'tool/call':
        return typeof data['name'] === 'string' ? { type: 'tool-call', turn, name: data['name'] } : null
      case 'turn/end': {
        const reason = data['reason']
        const completed = isRecord(reason) && reason['kind'] === 'completed'
        return { type: 'turn-end', turn, completed }
      }
      case 'compaction/summary': {
        const text = textOf(data['summary'])
        const range = data['shadowedRange']
        if (!text || !isRecord(range)) return null
        return { type: 'compaction-summary', text, seqStart: Number(range['start']), seqEnd: Number(range['end']) }
      }
      case 'request/header': {
        const header = data['header']
        const config = isRecord(header) ? header['config'] : null
        if (isRecord(config) && typeof config['provider'] === 'string' && typeof config['model'] === 'string') {
          const route = { provider: config['provider'], model: config['model'] }
          this.routes.set(sessionId, route)
          if (this.last?.provider !== route.provider || this.last?.model !== route.model) {
            this.last = route
            this.onRoute?.(route)
          }
        }
        return null
      }
      default:
        return null
    }
  }
}
