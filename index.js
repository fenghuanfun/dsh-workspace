/**
 * Host half of the `dsh-workspace` bundle.
 *
 * A DSH workspace owns exactly one directory (its registry `path`, which is also
 * a session's `header.cwd`). This plugin adds *additional* source directories to
 * one workspace, without touching that registry record:
 *
 * - the desired list is persisted per canonical workspace path,
 * - the browser half reads and writes it through two fenced HTTP routes,
 * - every live session of that workspace receives
 *   1. a session-scoped `sandboxPolicy.registerWritableRoot()` grant per
 *      directory, so it carries the same permission policy as the workspace
 *      directory itself, and
 *   2. one short prompt line listing the directories as workspace sources.
 *
 * Only existing directories are stored; the caller always sends the complete
 * desired list, so add and remove are one code path.
 */

import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'

/** Cordis function-plugin name. */
export const name = 'dsh-workspace'
/** The route carrier, the trust fence, and the services this plugin feeds. */
export const inject = ['webServer', 'connection', 'systemPrompt', 'sandboxPolicy', 'agents']

/** Read route: the stored list for one workspace directory. */
const LIST_PATH = '/dsh-workspace/list'
/** Write route: replace the stored list for one workspace directory. */
const SET_PATH = '/dsh-workspace/set'
/** Upper bound on additional source directories per workspace. */
const MAX_DIRECTORIES = 32
/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024
/** Durable file version of the stored document. */
const STORE_VERSION = 1
/** Prompt context name; unique inside the session scope this plugin renders in. */
const PROMPT_CONTEXT = 'dsh-workspace:current'

/** Absolute path of the durable document: `<DSH_HOME>/storages/dsh-workspace.json`. */
function storePath() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'storages', 'dsh-workspace.json')
}

/** One rejected request, carrying the status and message the route answers with. */
class WorkspaceDirectoriesError extends Error {
  /**
   * @param {number} status - HTTP status to answer with.
   * @param {string} message - caller-facing reason.
   */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Send one JSON response; these facts are live, so nothing is cached. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Answer one request with an error object. */
function sendFailure(res, error) {
  const status = error instanceof WorkspaceDirectoriesError ? error.status : 500
  const message = error instanceof Error ? error.message : String(error)
  if (status === 500) sendJson(res, status, { code: 'internal', message })
  else sendJson(res, status, { code: 'bad-request', message })
}

/** Answer 405 with the route's one supported method. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Resolve one absolute directory path to its canonical spelling and info. */
async function canonicalDirectory(requested) {
  if (typeof requested !== 'string' || requested === '') {
    throw new WorkspaceDirectoriesError(400, 'workspace must be a non-empty absolute directory path')
  }
  if (requested.includes('\0') || !isAbsolute(requested)) {
    throw new WorkspaceDirectoriesError(400, `workspace must be an absolute directory path: ${JSON.stringify(requested)}`)
  }
  let canonical
  let info
  try {
    canonical = await realpath(requested)
    info = await stat(canonical)
  } catch {
    throw new WorkspaceDirectoriesError(404, `workspace directory does not exist: ${requested}`)
  }
  if (!info.isDirectory()) throw new WorkspaceDirectoriesError(400, `workspace is not a directory: ${requested}`)
  return canonical
}

/**
 * Normalize one complete desired list against its workspace directory.
 * Canonicalizes, drops the workspace directory itself and directories already
 * covered by a kept ancestor, and keeps the caller's order.
 * @returns the accepted canonical directories.
 */
async function normalizeDirectories(workspace, requested) {
  if (!Array.isArray(requested)) {
    throw new WorkspaceDirectoriesError(400, '"dirs" must be an array of absolute directory paths')
  }
  if (requested.length > MAX_DIRECTORIES) {
    throw new WorkspaceDirectoriesError(400, `at most ${String(MAX_DIRECTORIES)} source directories are supported`)
  }
  const accepted = []
  for (const entry of requested) {
    if (typeof entry !== 'string' || entry === '' || entry.includes('\0') || !isAbsolute(entry)) {
      throw new WorkspaceDirectoriesError(400, `source directory must be an absolute path: ${JSON.stringify(entry)}`)
    }
    let canonical
    let info
    try {
      canonical = await realpath(entry)
      info = await stat(canonical)
    } catch {
      throw new WorkspaceDirectoriesError(404, `source directory does not exist: ${entry}`)
    }
    if (!info.isDirectory()) throw new WorkspaceDirectoriesError(400, `source directory is not a directory: ${entry}`)
    // The workspace directory is already a source; keeping it twice is noise.
    if (canonical === workspace) continue
    // A directory covering another one makes the nested entry meaningless.
    const covered = accepted.some(kept => canonical === kept || canonical.startsWith(kept + sep))
    if (covered) continue
    const covers = accepted.findIndex(kept => kept.startsWith(canonical + sep))
    if (covers !== -1) accepted.splice(covers, 1)
    accepted.push(canonical)
  }
  return accepted
}

/**
 * Register the durable store, the two routes, and the per-session effects.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  const file = storePath()
  /** @type {{ version: number, workspaces: Record<string, string[]> } | undefined} */
  let state
  /** @type {Promise<unknown> | undefined} */
  let loading
  /** Serializes every read-modify-write of the durable document. */
  let mutationQueue = Promise.resolve()
  /** Canonical workspace directory of each live agent (null when unknown). */
  const agentWorkspaces = new Map()
  /** Disposers of each live agent's writable-root grants. */
  const writes = new Map()
  /** Prompt fibers registered on each live agent's context. */
  const promptFibers = new Map()

  /** Read the durable document once, tolerating a missing or corrupt file. */
  async function load() {
    if (state !== undefined) return state
    loading ??= (async () => {
      let document = { version: STORE_VERSION, workspaces: {} }
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.workspaces === 'object' && parsed.workspaces !== null) {
          const workspaces = {}
          for (const [key, value] of Object.entries(parsed.workspaces)) {
            if (Array.isArray(value)) workspaces[key] = value.filter(entry => typeof entry === 'string')
          }
          document = { version: STORE_VERSION, workspaces }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          ctx.logger.warn(`dsh-workspace: ignoring unreadable store ${file}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      state = document
      return state
    })()
    return loading
  }

  /**
   * Persist one document atomically (temp file + rename). The caller owns the
   * snapshot, so a failed write never leaves the published state ahead of disk.
   * @param {{ version: number, workspaces: Record<string, string[]> }} document - state to write.
   */
  async function persist(document) {
    const text = `${JSON.stringify({ version: STORE_VERSION, workspaces: document.workspaces }, null, 2)}\n`
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${String(Date.now())}.tmp`
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, file)
  }

  /**
   * Run one durable mutation in order: read, validate, write, then publish.
   * Publishing (in-memory state and per-session effects) happens only after the
   * write succeeded, so a rejected save leaves memory, disk and grants aligned.
   * @param {() => Promise<unknown>} operation - the complete mutation.
   */
  function mutate(operation) {
    const task = mutationQueue.then(operation)
    // Keep the queue alive after a failed mutation; the caller still sees the rejection.
    mutationQueue = task.catch(() => {})
    return task
  }

  /** Stored source directories of one canonical workspace directory. */
  function storedFor(workspace) {
    if (workspace === null || workspace === undefined) return []
    return state?.workspaces[workspace] ?? []
  }

  /** Prompt text for one session, or '' when the workspace has no extra directory. */
  function promptText(agent) {
    const directories = storedFor(agentWorkspaces.get(agent) ?? null)
    if (directories.length === 0) return ''
    return [
      'Also part of this workspace, with the same permissions and policy as its working directory:',
      ...directories.map(directory => `- ${JSON.stringify(directory)}`),
    ].join('\n')
  }

  /** Install this agent's prompt context and writable-root grants from the store. */
  function syncAgent(agent) {
    const workspace = agentWorkspaces.get(agent) ?? null
    const directories = storedFor(workspace)
    for (const dispose of writes.get(agent) ?? []) dispose()
    writes.delete(agent)
    const disposers = []
    for (const directory of directories) {
      try {
        disposers.push(ctx.sandboxPolicy.registerWritableRoot(agent.session, directory))
      } catch (error) {
        ctx.logger.warn(`dsh-workspace: cannot grant ${directory}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (disposers.length > 0) writes.set(agent, disposers)
    if (promptFibers.get(agent) === undefined) {
      const fiber = agent.ctx.inject(['systemPrompt'], scope => {
        scope.systemPrompt.context({
          name: PROMPT_CONTEXT,
          order: scope.systemPrompt.getContextOrder('WORKING_DIRECTORY') + 5,
          required: true,
          interpolate: false,
          text: () => promptText(agent),
        })
      })
      promptFibers.set(agent, fiber)
    }
  }

  /** Resolve an agent's canonical workspace directory, then install its effects. */
  async function attachAgent(agent) {
    const cwd = agent.session.header.cwd
    if (typeof cwd === 'string' && cwd !== '') {
      try {
        agentWorkspaces.set(agent, await realpath(cwd))
      } catch {
        agentWorkspaces.set(agent, cwd)
      }
    } else {
      agentWorkspaces.set(agent, null)
    }
    syncAgent(agent)
  }

  /** Drop every effect owned for one agent. */
  function detachAgent(agent) {
    for (const dispose of writes.get(agent) ?? []) dispose()
    writes.delete(agent)
    const fiber = promptFibers.get(agent)
    promptFibers.delete(agent)
    agentWorkspaces.delete(agent)
    if (fiber !== undefined) void fiber.dispose().catch(() => {})
  }

  /** Re-install every live agent of one workspace after its list changed. */
  function resyncWorkspace(workspace) {
    for (const agent of ctx.agents.list()) {
      if (agentWorkspaces.get(agent) === workspace) syncAgent(agent)
    }
  }

  /** Fold the trust fence: true when the request was already answered. */
  function rejected(req, res) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** Read the `workspace` query parameter of a GET route. */
  function workspaceQuery(req) {
    const url = new URL(String(req.url), 'http://localhost')
    return url.searchParams.get('workspace') ?? ''
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LIST_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      try {
        await load()
        const workspace = await canonicalDirectory(workspaceQuery(req))
        const dirs = await Promise.all(storedFor(workspace).map(async (directory) => {
          let available = true
          try {
            available = (await stat(directory)).isDirectory()
          } catch {
            available = false
          }
          return { path: directory, available }
        }))
        sendJson(res, 200, { workspace, dirs })
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `dsh-workspace: GET ${LIST_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SET_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      try {
        const text = await readBoundedBody(req)
        if (text === null) throw new WorkspaceDirectoriesError(413, 'request body is too large')
        let body
        try {
          body = JSON.parse(text)
        } catch {
          throw new WorkspaceDirectoriesError(400, 'request body must be JSON')
        }
        if (body === null || typeof body !== 'object') {
          throw new WorkspaceDirectoriesError(400, 'request body must be a JSON object')
        }
        const committed = await mutate(async () => {
          await load()
          const workspace = await canonicalDirectory(body.workspace)
          const directories = await normalizeDirectories(workspace, body.dirs)
          const current = state ?? { version: STORE_VERSION, workspaces: {} }
          const workspaces = { ...current.workspaces }
          if (directories.length === 0) delete workspaces[workspace]
          else workspaces[workspace] = directories
          const next = { version: STORE_VERSION, workspaces }
          await persist(next)
          state = next
          resyncWorkspace(workspace)
          return { workspace, directories }
        })
        sendJson(res, 200, {
          workspace: committed.workspace,
          dirs: committed.directories.map(path => ({ path, available: true })),
        })
      } catch (error) {
        sendFailure(res, error)
      }
    },
  }), `dsh-workspace: POST ${SET_PATH}`)

  ctx.on('agent/created', async ({ agent }) => {
    await load()
    await attachAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { detachAgent(agent) })

  // Agents that already run when this plugin activates (a reload, or an install
  // into a live process) get the same effects.
  void (async () => {
    await load()
    for (const agent of ctx.agents.list()) await attachAgent(agent)
  })().catch((error) => {
    ctx.logger.warn(`dsh-workspace: initial sync failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  ctx.effect(() => () => {
    for (const agent of [...writes.keys(), ...promptFibers.keys()]) detachAgent(agent)
  }, 'dsh-workspace: per-agent effects')
}
