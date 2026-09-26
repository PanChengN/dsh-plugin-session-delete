/**
 * 主机半：注册 `POST /api/dsh-session-delete`，真正从磁盘上删除一个会话。
 *
 * 删除三处内容（与手动清理等价）：
 *   1. `$DSH_HOME/sessions/<工作区>/<session-id>/`                会话正文与写锁
 *   2. `$DSH_HOME/storages/session_projcache/sessions/<id>.json`   派生缓存（标题等）
 *   3. `$DSH_HOME/storages/workspace.json` 中该 id 的引用           归档标记与工作区分组
 *
 * 若运行时的 zlib 支持 zstd 解压，还会连带删除该会话的子智能体会话
 * （header.parentSession 指向它的那些）；不支持时跳过并在响应里说明。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

export const name = 'session-delete'
export const inject = ['webServer']

const ROUTE = '/api/dsh-session-delete'
const LOG_NAME = 'session.v3.jsonl.zstd'

/** `$DSH_HOME`，与 Harness 其余部分保持一致。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** 会话 id 有 `session-<uuid>` 与裸 `<uuid>` 两种落盘形式，两种都要认。 */
function idVariants(id) {
  return id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`]
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 只读会话日志的第一行 header；运行时无 zstd 时返回 undefined。 */
function readHeader(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') return undefined
  const text = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8')
  const end = text.indexOf('\n')
  return JSON.parse(end < 0 ? text : text.slice(0, end))
}

/** 枚举 `sessions/<工作区>/<会话>` 下的全部会话目录。 */
function listSessionDirs(root) {
  const rows = []
  if (!existsSync(root)) return rows
  for (const workspaceDir of readdirSync(root)) {
    const workspacePath = join(root, workspaceDir)
    let workspaceStat
    try {
      workspaceStat = statSync(workspacePath)
    } catch {
      continue
    }
    if (!workspaceStat.isDirectory()) continue
    for (const name of readdirSync(workspacePath)) {
      const dir = join(workspacePath, name)
      let dirStat
      try {
        dirStat = statSync(dir)
      } catch {
        continue
      }
      if (dirStat.isDirectory()) rows.push({ dir, name })
    }
  }
  return rows
}

/** 会话在 header 里记录自己的 id，比目录名更权威。 */
function sessionIdOf(row) {
  const log = join(row.dir, LOG_NAME)
  if (!existsSync(log)) return row.name
  try {
    const header = readHeader(log)
    if (header !== undefined && typeof header.id === 'string' && header.id.length > 0) return header.id
    if (header !== undefined && typeof header.parentSession === 'string') return row.name
  } catch {
    return row.name
  }
  return row.name
}

/** header.parentSession 落在给定集合里的会话目录。 */
function findChildren(rows, parentNames) {
  const children = []
  if (typeof zlib.zstdDecompressSync !== 'function') return children
  for (const row of rows) {
    const log = join(row.dir, LOG_NAME)
    if (!existsSync(log)) continue
    try {
      const header = readHeader(log)
      if (header !== undefined && typeof header.parentSession === 'string' && parentNames.has(header.parentSession)) {
        children.push(row)
      }
    } catch {
      continue
    }
  }
  return children
}

/** 从 workspace.json 中摘掉这些 id 的引用。 */
function cleanWorkspaceState(file, names) {
  const result = { archived: 0, groups: 0 }
  if (!existsSync(file)) return result
  const gone = new Set(names)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const archived = doc?.global?.archivedSessionIds
  if (Array.isArray(archived)) {
    const before = archived.length
    doc.global.archivedSessionIds = archived.filter((id) => !gone.has(id))
    result.archived = before - doc.global.archivedSessionIds.length
  }
  const workspaces = doc?.tables?.workspaces
  if (workspaces !== null && typeof workspaces === 'object' && workspaces !== undefined) {
    for (const workspace of Object.values(workspaces)) {
      if (Array.isArray(workspace?.sessionIds)) {
        const before = workspace.sessionIds.length
        workspace.sessionIds = workspace.sessionIds.filter((id) => !gone.has(id))
        result.groups += before - workspace.sessionIds.length
      }
    }
  }
  writeFileSync(file, JSON.stringify(doc, null, 2))
  return result
}

async function handle(ctx, req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: 'method-not-allowed' })

  let sessionId = ''
  try {
    const payload = JSON.parse(await readBody(req))
    if (typeof payload?.sessionId === 'string') sessionId = payload.sessionId.trim()
  } catch {
    return send(400, { ok: false, error: 'invalid-json' })
  }
  if (sessionId.length === 0) return send(400, { ok: false, error: 'missing-session-id' })

  const home = dshHome()
  const sessionsRoot = join(home, 'sessions')
  const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
  const workspaceFile = join(home, 'storages', 'workspace.json')

  try {
    const rows = listSessionDirs(sessionsRoot)
    const requested = new Set(idVariants(sessionId))
    const targets = rows.filter((row) => requested.has(row.name) || requested.has(sessionIdOf(row)))

    // 子智能体会话：header.parentSession 指向本次要删的会话之一。
    const parentNames = new Set()
    for (const name of requested) parentNames.add(name)
    for (const row of targets) for (const name of idVariants(sessionIdOf(row))) parentNames.add(name)
    const children = findChildren(rows, parentNames).filter((child) => !targets.includes(child))

    const removed = []
    for (const row of [...targets, ...children]) {
      rmSync(row.dir, { recursive: true, force: true })
      removed.push(row)
    }

    // 被删会话（含子会话）的全部 id 形式，用于清缓存与状态引用。
    const victims = new Set()
    for (const row of removed) {
      for (const name of idVariants(sessionIdOf(row))) victims.add(name)
      for (const name of idVariants(row.name)) victims.add(name)
    }
    for (const name of requested) victims.add(name)

    const caches = []
    if (existsSync(cacheRoot)) {
      const present = new Set(readdirSync(cacheRoot).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)))
      for (const name of victims) {
        if (present.has(name)) {
          rmSync(join(cacheRoot, `${name}.json`), { force: true })
          caches.push(name)
        }
      }
    }

    const workspace = cleanWorkspaceState(workspaceFile, [...victims])

    // 让浏览器把该会话从列表快照里移除：`api-session/removed` 由 dsh-api-remotes 转发到客户端，
    // 客户端 ClientSessions.handleSessionRemoved 会据此删掉列表行（侧栏对没有 summary 的 id 直接跳过），
    // 因此页面不需要整页刷新。先发客户端传来的那个 id，保证一定命中。
    const announced = new Set([sessionId])
    for (const row of removed) {
      announced.add(row.name)
      announced.add(sessionIdOf(row))
    }
    const emitted = []
    for (const name of announced) {
      if (typeof name !== 'string' || name.length === 0) continue
      try {
        ctx.emit('api-session/removed', name)
        emitted.push(name)
      } catch {
        // 事件通道不可用时不影响删除本身；客户端会退化为重新拉取列表。
      }
    }

    return send(200, {
      ok: true,
      sessionId,
      removedSessions: targets.length,
      removedChildren: children.length,
      removedCaches: caches.length,
      workspace,
      emitted: emitted.length,
      zstd: typeof zlib.zstdDecompressSync === 'function',
    })
  } catch (error) {
    return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => {
    const dispose = webServer.register({ kind: 'exact', path: ROUTE, handler: (req, res) => handle(ctx, req, res) })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })
}
