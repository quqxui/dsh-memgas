import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { GLOBAL_SCOPE, projectKeyFor } from '@memgas/core'

export { GLOBAL_SCOPE }

function gitRemote(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    // Not a checkout, no origin, or git is missing: the directory key still works.
    return null
  }
}

/** The project scope for a working directory, stable across clones of one repo. */
export function resolveScope(cwd: string): string {
  return projectKeyFor({ gitRemote: gitRemote(cwd), cwd })
}

/**
 * One SQLite file per scope, so a user can export, sync or delete a single
 * project's memories without touching anything else.
 */
export function storePathFor(home: string, scope: string): string {
  const slug = scope.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const digest = createHash('sha256').update(scope).digest('hex').slice(0, 8)
  return join(home, 'memgas', `${slug}-${digest}.sqlite`)
}
