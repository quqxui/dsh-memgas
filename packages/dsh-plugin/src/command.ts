import { formatCard, formatDiagnostics, type MemoryService } from '@memgas/core'

export interface CommandContext {
  memory: MemoryService
  scope: string
  /** Rendered by the plugin so `/memory status` and `memory_status` never drift. */
  status: () => string
}

export interface MemoryCommandResult {
  kind: 'success' | 'error'
  text?: string
}

const USAGE = `/memory 用法：
  status              记忆条数、向量模型、索引与通道状态
  search <关键词>      检索并列出记忆卡片
  diag <关键词>        显示各通道的原始结果与融合过程
  list [数量]         按重要度列出本项目的记忆
  forget <id>         归档一条记忆（可恢复，不删除）
  restore <id>        把归档的记忆恢复为启用
  pin <id>            标记为常驻，不受自动衰减影响
  review [accept <id> | reject <id> | accept-all]
                      处理等待确认的记忆（仅在 confirmWrites 打开时会有）
  export              以 JSON 导出本项目的记忆
  purge --yes         物理删除本项目的全部记忆（不可恢复）`

const ok = (text: string): MemoryCommandResult => ({ kind: 'success', text })
const fail = (text: string): MemoryCommandResult => ({ kind: 'error', text })

const EXPORT_LIMIT = 5000
const LIST_LIMIT = 20

/**
 * The human-facing half of the plugin. Everything here is deliberately
 * reversible except `purge`, which is why that one needs `--yes` spelled out.
 */
export async function runMemoryCommand(input: string, context: CommandContext): Promise<MemoryCommandResult> {
  const [subcommand = '', ...rest] = input.trim().split(/\s+/).filter(Boolean)
  const argument = rest.join(' ')
  const { memory, scope } = context

  switch (subcommand) {
    case '':
    case 'help':
      return ok(USAGE)

    case 'status':
      return ok(context.status())

    case 'search': {
      if (!argument) return fail('用法：/memory search <关键词>')
      const result = await memory.search({ query: argument, scopes: [scope, 'global'], k: 10 })
      if (result.items.length === 0) return ok(`没有找到与「${argument}」相关的记忆。`)
      return ok(result.items.map(item => formatCard(item.unit)).join('\n\n'))
    }

    case 'diag': {
      if (!argument) return fail('用法：/memory diag <关键词>')
      const result = await memory.search({ query: argument, scopes: [scope, 'global'], k: 10 })
      return ok(formatDiagnostics(argument, result))
    }

    case 'list': {
      const limit = Number(argument) > 0 ? Math.min(Number(argument), 100) : LIST_LIMIT
      const units = memory.store.listActive({ scopes: [scope], limit })
      if (units.length === 0) return ok('本项目还没有记忆。')
      return ok(units.map(unit => formatCard(unit)).join('\n\n'))
    }

    case 'forget': {
      if (!argument) return fail('用法：/memory forget <id>')
      if (!memory.store.get(argument)) return fail(`没有这条记忆：${argument}`)
      memory.store.patch(argument, { status: 'archived', updatedAt: Date.now() })
      return ok(`已归档 ${argument}。记忆仍在库中，可用 /memory restore 恢复。`)
    }

    case 'restore': {
      if (!argument) return fail('用法：/memory restore <id>')
      if (!memory.store.get(argument)) return fail(`没有这条记忆：${argument}`)
      memory.store.patch(argument, { status: 'active', updatedAt: Date.now() })
      return ok(`已恢复 ${argument}。`)
    }

    case 'pin': {
      if (!argument) return fail('用法：/memory pin <id>')
      if (!memory.store.get(argument)) return fail(`没有这条记忆：${argument}`)
      memory.store.patch(argument, { status: 'active', updatedAt: Date.now() })
      memory.store.pin(argument)
      return ok(`已把 ${argument} 标记为常驻，不再参与自动衰减。`)
    }

    case 'review': {
      const [action, id] = rest
      const pending = () => memory.store.listUnits({ scopes: [scope], statuses: ['pending'], limit: 50 })

      if (!action) {
        const waiting = pending()
        if (waiting.length === 0) return ok('没有等待确认的记忆。')
        const listed = waiting.map(unit => formatCard(unit)).join('\n\n')
        return ok(`${waiting.length} 条记忆等待确认：\n\n${listed}\n\n用 /memory review accept <id> 采纳，reject <id> 丢弃，accept-all 全部采纳。`)
      }

      if (action === 'accept-all') {
        const waiting = pending()
        for (const unit of waiting) memory.store.patch(unit.id, { status: 'active', updatedAt: Date.now() })
        return ok(`已采纳 ${waiting.length} 条记忆。`)
      }

      if (action !== 'accept' && action !== 'reject') return fail('用法：/memory review [accept <id> | reject <id> | accept-all]')
      if (!id) return fail(`用法：/memory review ${action} <id>`)
      const unit = memory.store.get(id)
      if (!unit || unit.status !== 'pending') return fail(`没有这条待确认的记忆：${id}`)
      memory.store.patch(id, { status: action === 'accept' ? 'active' : 'archived', updatedAt: Date.now() })
      return ok(action === 'accept' ? `已采纳 ${id}。` : `已丢弃 ${id}（仍可用 /memory restore 恢复）。`)
    }

    case 'export': {
      const units = memory.store.listUnits({ scopes: [scope], limit: EXPORT_LIMIT })
      return ok(JSON.stringify({ scope, exportedAt: new Date().toISOString(), units }, null, 2))
    }

    case 'purge': {
      if (argument !== '--yes') {
        return fail('这会物理删除本项目的全部记忆且无法恢复。确认请执行：/memory purge --yes')
      }
      const before = memory.status().units
      memory.store.purgeScope(scope)
      return ok(`已删除本项目的 ${before} 条记忆。`)
    }

    default:
      return fail(`未知子命令「${subcommand}」。\n\n${USAGE}`)
  }
}
