import { createHash } from 'node:crypto'
import { basename } from 'node:path'

/** Scope holding cross-project memories about the user. */
export const GLOBAL_SCOPE = 'global'

/**
 * Reduce a git remote URL to a stable `host/owner/repo` key.
 *
 * The same repository reached over ssh, https or with credentials embedded
 * must produce one key, otherwise the same project would own several
 * disconnected memory stores.
 */
export function normalizeGitRemote(remote: string): string | null {
  const raw = remote.trim()
  if (!raw) return null

  // scp-like syntax: git@host:owner/repo.git
  const scpLike = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(raw)
  let host: string
  let path: string
  if (scpLike) {
    host = scpLike[1]!
    path = scpLike[2]!
  } else {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    host = url.hostname
    path = url.pathname
  }

  host = host.toLowerCase().replace(/^www\./, '')
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
  if (!host || !path) return null
  return `${host}/${path}`
}

/**
 * The scope key for the project a session is working in. Falls back to the
 * working directory when the project is not a git checkout; the hash keeps
 * two directories sharing a basename apart.
 */
export function projectKeyFor(input: { gitRemote: string | null; cwd: string }): string {
  const normalized = input.gitRemote ? normalizeGitRemote(input.gitRemote) : null
  if (normalized) return `project:${normalized}`
  const digest = createHash('sha256').update(input.cwd).digest('hex').slice(0, 8)
  return `project:cwd/${basename(input.cwd)}-${digest}`
}
