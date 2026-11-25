// RPC toggle endpoint: settings.mutate write, VolatileRef sync, roster refresh,
// SETTINGS_CONFLICT retry, and input validation.
// Run: node test/presets-toggle.test.mjs (after `npm run build`)
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerPresetsRpc } from '../lib/presets-rpc.js'
import { SUBAGENTS_SETTINGS_NAMESPACE } from '../lib/subagents-command.js'

const dir = mkdtempSync(join(tmpdir(), 'presets-toggle-rpc-'))
try {
  for (const name of ['alpha', 'beta']) {
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: "the ${name} agent"\n---\nBody.\n`)
  }
  const routes = new Map()
  let disabledList = []
  let revision = 1
  let refreshes = 0
  let conflictOnce = false
  let settingsEnabled = true

  const fakeSettings = {
    describe() {
      return [{ ns: SUBAGENTS_SETTINGS_NAMESPACE, revision, value: { disabledAgents: [...disabledList] } }]
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, SUBAGENTS_SETTINGS_NAMESPACE)
      if (conflictOnce) {
        conflictOnce = false
        revision++
        throw Object.assign(new Error('SETTINGS_CONFLICT'), { code: 'SETTINGS_CONFLICT' })
      }
      assert.equal(expectedRevision, revision)
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1 && op.path[0] === 'disabledAgents') {
          disabledList = [...op.value]
        }
      }
      revision++
    },
  }

  const fakeCtx = {
    get(name) {
      if (name === 'settings' && settingsEnabled) return fakeSettings
      return undefined
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }

  const disabledRef = { get: () => disabledList }
  await registerPresetsRpc(fakeCtx, dir, async () => { refreshes++ }, () => 'zh', disabledRef)

  async function rpc(endpoint, payload) {
    const route = routes.get(`/api/subagent-presets/${endpoint}`)
    assert.ok(route, `route registered for ${endpoint}`)
    const req = new Request(`http://127.0.0.1/api/subagent-presets/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: `subagent-presets/${endpoint}`, payload }),
    })
    const res = await route.fetch(req)
    assert.equal(res.status, 200)
    const json = await res.json()
    return json.result.value
  }

  // Initial list reports canToggle=true and empty disabledAgents.
  const initial = await rpc('list', null)
  assert.equal(initial.ok, true)
  assert.equal(initial.value.canToggle, true)
  assert.deepEqual(initial.value.disabledAgents, [])

  // Disable alpha with a simulated SETTINGS_CONFLICT retry.
  conflictOnce = true
  const beforeRefreshes = refreshes
  const disabledAlpha = await rpc('toggle', { id: 'alpha', enabled: false })
  assert.equal(disabledAlpha.ok, true)
  assert.deepEqual(disabledAlpha.value, { id: 'alpha', enabled: false, disabledAgents: ['alpha'] })
  assert.deepEqual(disabledList, ['alpha'])
  assert.equal(refreshes, beforeRefreshes + 1, 'toggle refreshes tool roster')

  // Concurrent toggles serialize cleanly.
  const [r1, r2] = await Promise.all([
    rpc('toggle', { id: 'beta', enabled: false }),
    rpc('toggle', { id: 'alpha', enabled: true }),
  ])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.deepEqual(disabledList, ['beta'])

  // List reflects updated disabledAgents.
  const after = await rpc('list', null)
  assert.equal(after.ok, true)
  assert.deepEqual(after.value.disabledAgents, ['beta'])

  // Validation errors.
  assert.equal((await rpc('toggle', null)).code, 'invalid_input')
  assert.equal((await rpc('toggle', { id: 'alpha', enabled: 'false' })).code, 'invalid_input')
  assert.equal((await rpc('toggle', { id: 'alpha', enabled: false, extra: 1 })).code, 'invalid_input')
  assert.equal((await rpc('toggle', { id: '../escape', enabled: false })).code, 'invalid_id')
  assert.equal((await rpc('toggle', { id: 'missing', enabled: false })).code, 'not_found')

  // Dynamic settings absence reflects in list and toggle.
  settingsEnabled = false
  const noSettingsList = await rpc('list', null)
  assert.equal(noSettingsList.value.canToggle, false)
  assert.equal((await rpc('toggle', { id: 'alpha', enabled: false })).code, 'settings_unavailable')

  console.log('presets-toggle: PASS — RPC toggle, VolatileRef sync, conflict retry, validation, and dynamic settings check')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
