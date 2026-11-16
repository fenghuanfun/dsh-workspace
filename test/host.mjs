/**
 * Host-half tests for dsh-workspace: drives the registered HTTP routes and the
 * per-agent effects with a fake Cordis host, so validation, persistence,
 * per-session grants and prompt text are exercised without the running app.
 *
 * Run with `npm test` (Node 20+). No dependency is installed.
 */
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = await mkdtemp(join(tmpdir(), 'dsh-workspace-test-'))
process.env.DSH_HOME = home

// The Host half is a Cordis function plugin: a fake context is enough to drive
// its routes, its durable document and its per-agent effects.
const plugin = await import('../index.js')

const routes = new Map()
const disposed = []
const grants = []
const promptContexts = []
const events = new Map()
const warnings = []
const liveAgents = []

const ctx = {
  logger: { warn: (message) => warnings.push(message) },
  effect: (factory) => {
    const disposer = factory()
    return () => { disposer?.() }
  },
  on: (name, handler) => { events.set(name, handler) },
  agents: { list: () => liveAgents },
  connection: { requestRejection: () => undefined },
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  sandboxPolicy: {
    registerWritableRoot: (session, directory) => {
      grants.push({ session: session.id, directory })
      const dispose = () => {
        const index = grants.findIndex(entry => entry.directory === directory && entry.session === session.id)
        if (index !== -1) grants.splice(index, 1)
      }
      disposed.push(dispose)
      return dispose
    },
  },
}

plugin.apply(ctx)

/** Fake response collecting the JSON body. */
function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

async function call(path, { method = 'GET', query = '', body, contentType = 'application/json' } = {}) {
  const route = routes.get(path.split('?')[0])
  if (route === undefined) throw new Error(`no route ${path}`)
  const res = response()
  const req = {
    method,
    url: path,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    },
    resume() {},
  }
  await route.handler(req, res)
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.statusCode, json, headers: res.headers }
}

const root = join(home, 'root-workspace')
const nested = join(root, 'packages')
const other = join(home, 'other-source')
const deeper = join(other, 'src')
await mkdir(nested, { recursive: true })
await mkdir(deeper, { recursive: true })
// macOS /var is a symlink: the plugin stores canonical paths, so compare those.
const rootCanon = await realpath(root)
const otherCanon = await realpath(other)
const nestedCanon = await realpath(nested)

const results = []
const check = (name, condition, detail) => {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`FAIL ${name}`, detail ?? '')
}

check('routes registered', routes.size === 2, [...routes.keys()])

let listed = await call(`/dsh-workspace/list?workspace=${encodeURIComponent(root)}`)
check('list empty', listed.status === 200 && listed.json.dirs.length === 0, listed)

let saved = await call('/dsh-workspace/set', {
  method: 'POST',
  body: { workspace: root, dirs: [other, other, nested] },
})
check('set dedupes and keeps both independent directories', saved.status === 200 && saved.json.dirs.length === 2 && saved.json.dirs[0].path === otherCanon, saved)

saved = await call('/dsh-workspace/set', {
  method: 'POST',
  body: { workspace: root, dirs: [other, deeper] },
})
check('nested directory folded into ancestor', saved.status === 200 && saved.json.dirs.length === 1, saved)

saved = await call('/dsh-workspace/set', {
  method: 'POST',
  body: { workspace: root, dirs: [other, nested] },
})
check('second independent directory kept', saved.status === 200 && saved.json.dirs.length === 2, saved)

listed = await call(`/dsh-workspace/list?workspace=${encodeURIComponent(root)}`)
check('list reflects the saved order', listed.status === 200
  && listed.json.dirs.map(entry => entry.path).join('|') === [otherCanon, nestedCanon].join('|'), listed)

const relative = await call('/dsh-workspace/set', {
  method: 'POST',
  body: { workspace: root, dirs: ['relative/path'] },
})
check('relative path refused', relative.status === 400, relative)

const missing = await call('/dsh-workspace/set', {
  method: 'POST',
  body: { workspace: root, dirs: [join(home, 'nope')] },
})
check('missing directory refused', missing.status === 404, missing)

const file = join(home, 'a-file.txt')
await writeFile(file, 'x')
const notDirectory = await call('/dsh-workspace/set', {
  method: 'POST',
  body: { workspace: root, dirs: [file] },
})
check('non-directory refused', notDirectory.status === 400, notDirectory)

const selfOnly = await call('/dsh-workspace/set', {
  method: 'POST',
  body: { workspace: root, dirs: [root] },
})
check('workspace itself ignored', selfOnly.status === 200 && selfOnly.json.dirs.length === 0, selfOnly)

const wrongType = await call('/dsh-workspace/set', {
  method: 'POST',
  body: { workspace: root, dirs: [other] },
  contentType: 'text/plain',
})
check('non-json content type refused', wrongType.status === 415, wrongType)

const unknownWorkspace = await call(`/dsh-workspace/list?workspace=${encodeURIComponent(join(home, 'ghost'))}`)
check('unknown workspace refused', unknownWorkspace.status === 404, unknownWorkspace)

const method = await call(`/dsh-workspace/list?workspace=${encodeURIComponent(root)}`, { method: 'POST' })
check('wrong method refused', method.status === 405, method)

// Second workspace keeps its own list.
await call('/dsh-workspace/set', { method: 'POST', body: { workspace: other, dirs: [nested] } })
const rootList = await call(`/dsh-workspace/list?workspace=${encodeURIComponent(root)}`)
const otherList = await call(`/dsh-workspace/list?workspace=${encodeURIComponent(other)}`)
check('lists are per workspace', rootList.json.dirs.length === 0 && otherList.json.dirs.length === 1,
  { root: rootList.json, other: otherList.json })

const stored = JSON.parse(await readFile(join(home, 'storages', 'dsh-workspace.json'), 'utf8'))
check('durable document written', stored.version === 1 && Array.isArray(stored.workspaces[otherCanon]), stored)

// Per-agent effects: a session of the workspace owns the second workspace's grant only
// when its cwd is that workspace.
await call('/dsh-workspace/set', { method: 'POST', body: { workspace: root, dirs: [other, nested] } })
const session = { id: 'session-1', header: { cwd: root } }
const agent = {
  session,
  ctx: {
    inject: (services, callback) => {
      callback({
        systemPrompt: {
          getContextOrder: () => 100,
          context: (contribution) => { promptContexts.push(contribution); return () => {} },
        },
      })
      return { dispose: async () => {} }
    },
  },
}
const created = events.get('agent/created')
if (created === undefined) throw new Error('agent/created not registered')
liveAgents.push(agent)
await created({ agent })
check('grant per directory', grants.length === 2, grants)
check('prompt context registered once', promptContexts.length === 1, promptContexts.length)
const text = promptContexts[0]?.text?.()
check('prompt lists both directories', typeof text === 'string' && text.includes(otherCanon) && text.includes(nestedCanon), text)
check('prompt orders after working directory', promptContexts[0]?.order === 105, promptContexts[0]?.order)
check('prompt is required', promptContexts[0]?.required === true, promptContexts[0])

// A later save re-syncs the live agent.
await call('/dsh-workspace/set', { method: 'POST', body: { workspace: root, dirs: [other] } })
check('live agent grants follow the saved list', grants.length === 1 && grants[0].directory === otherCanon, grants)
check('prompt follows the saved list', !promptContexts[0].text().includes(nestedCanon), promptContexts[0].text())

liveAgents.splice(0, liveAgents.length)
events.get('agent/disposed')({ agent })
check('disposal removes grants', grants.length === 0, grants)

// Durable writes are serialized: concurrent saves settle on one committed list.
await call('/dsh-workspace/set', { method: 'POST', body: { workspace: root, dirs: [] } })
const firstSave = call('/dsh-workspace/set', { method: 'POST', body: { workspace: root, dirs: [other] } })
const secondSave = call('/dsh-workspace/set', { method: 'POST', body: { workspace: root, dirs: [nested] } })
await Promise.all([firstSave, secondSave])
const afterRace = await call(`/dsh-workspace/list?workspace=${encodeURIComponent(root)}`)
const raceDoc = JSON.parse(await readFile(join(home, 'storages', 'dsh-workspace.json'), 'utf8'))
check('concurrent saves settle on the last enqueued list',
  afterRace.status === 200 && afterRace.json.dirs.length === 1 && afterRace.json.dirs[0].path === nestedCanon
  && raceDoc.workspaces[rootCanon]?.[0] === nestedCanon, { list: afterRace.json, doc: raceDoc.workspaces[rootCanon] })

// A rejected write publishes nothing: memory and disk keep the previous list.
const { chmod } = await import('node:fs/promises')
const storages = join(home, 'storages')
await chmod(storages, 0o500)
const failedSave = await call('/dsh-workspace/set', { method: 'POST', body: { workspace: root, dirs: [other] } })
await chmod(storages, 0o700)
const afterFailure = await call(`/dsh-workspace/list?workspace=${encodeURIComponent(root)}`)
check('failed write keeps the previous list', failedSave.status === 500
  && afterFailure.json.dirs.length === 1 && afterFailure.json.dirs[0].path === nestedCanon,
  { failedSave, afterFailure: afterFailure.json })

for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}`)
const failures = results.filter(entry => !entry.ok)
console.log(`\n${String(results.length - failures.length)}/${String(results.length)} checks passed`)
if (warnings.length > 0) console.log('warnings:', warnings)
if (failures.length > 0) {
  console.error('failures:', failures)
  process.exitCode = 1
}
