/** The only thing the core needs from a model: text in, text out. */
export interface LlmClient {
  complete(input: {
    system: string
    prompt: string
    maxTokens?: number
    signal?: AbortSignal
    /** Lets the host pick the same model the session itself is using. */
    sessionId?: string
  }): Promise<string>
}
