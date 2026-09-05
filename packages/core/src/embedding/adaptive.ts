import type { Embedder } from './types.ts'

export interface AdaptiveStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed'
  /** Id of the embedder currently answering `embed()`. */
  active: string
  reason?: string
}

export interface AdaptiveEmbedderOptions {
  fallback: Embedder
  load: () => Promise<Embedder>
  /** Called once the real model takes over, so callers can re-index. */
  onReady?: (id: string) => void
}

/**
 * Serves the fallback embedder until a heavier model finishes loading, then
 * switches to it.
 *
 * Loading a local model means a download on first use, so the plugin cannot
 * wait for it: memories written meanwhile carry the fallback's id and are
 * re-embedded afterwards. If the load never succeeds, nothing breaks — the
 * fallback keeps answering and the status says why.
 */
export class AdaptiveEmbedder implements Embedder {
  private active: Embedder
  private state: AdaptiveStatus['state'] = 'idle'
  private reason: string | undefined
  private loading: Promise<void> | null = null

  constructor(private readonly opts: AdaptiveEmbedderOptions) {
    this.active = opts.fallback
  }

  get id(): string {
    return this.active.id
  }

  get dimensions(): number {
    return this.active.dimensions
  }

  /** Begins loading in the background; safe to call repeatedly. */
  start(): void {
    if (this.loading) return
    this.state = 'loading'
    this.loading = this.opts.load()
      .then(model => {
        this.active = model
        this.state = 'ready'
        this.opts.onReady?.(model.id)
      })
      .catch(error => {
        this.state = 'failed'
        this.reason = error instanceof Error ? error.message : String(error)
      })
  }

  status(): AdaptiveStatus {
    return {
      state: this.state,
      active: this.active.id,
      ...(this.reason ? { reason: this.reason } : {}),
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return this.active.embed(texts)
  }
}
