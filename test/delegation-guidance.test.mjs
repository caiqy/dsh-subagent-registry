// Run with a published host SDK closure using --import ./test/host-sdk-imports.mjs.
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerDelegationGuidance } from '../src/delegation-guidance.ts'

const ctx = new Context()
await ctx.plugin(SystemPrompt)
const dispatch = { name: 'use_agent' }
const schemas = ['use_agent', 'ask_agent', 'subagent'].map(name => ({ name, parameters: { type: 'object' } }))
const calls = []
ctx.tools = {
  schemas(scope, toolSet) { calls.push(toolSet); return toolSet ? schemas.filter(t => toolSet.has(t.name)) : schemas },
  get(name) { return name === dispatch.name ? dispatch : undefined },
}
ctx.systemPrompt.section({ order: 1, name: 'tool:subagent', text: 'Start independent delegations with `subagent` together in one assistant message and continue useful work while they run.' })
ctx.systemPrompt.tools(context => ({ schemas: ctx.tools.schemas(context.scope, context.toolSet) }))
registerDelegationGuidance(ctx, dispatch, 'ask_agent')
try {
  const result = await ctx.systemPrompt.assemble()
  assert.match(result.sections.map(s => s.text).join('\n'), /from the `use_agent` roster/)
  assert.deepEqual(result.tools.map(t => t.name).sort(), schemas.map(t => t.name).sort())
  const hidden = await ctx.systemPrompt.assemble({ toolSet: new Set(['subagent']) })
  assert.doesNotMatch(hidden.sections.map(s => s.text).join('\n'), /from the `use_agent` roster/)
  const noAsk = await ctx.systemPrompt.assemble({ toolSet: new Set(['use_agent', 'subagent']) })
  assert.doesNotMatch(noAsk.sections.map(s => s.text).join('\n'), /Use `ask_agent`/)
  console.log('delegation-guidance: PASS — real assembly and per-step visibility')
} finally { await ctx.fiber.dispose() }

// New hosts admit conditional registrations once per step. Use the real registry
// and its opaque ToolSet rather than treating it as a collection of names.
if (process.env.DSH_TEST_HOST_VERSION === '0.2.2-rc.1') {
  const real = new Context()
  await real.plugin(SystemPrompt)
  await real.plugin(ToolRuntime)
  let enabled = true
  const tool = name => ({ name, description: name, parameters: { type: 'object' }, output: { schema: { type: 'string' }, render: value => value }, execute: async () => '' })
  const custom = tool('use_agent')
  real.tools.register(custom, { when: () => enabled })
  real.tools.register(tool('ask_agent'), { when: () => false })
  real.tools.register(tool('subagent'))
  const disposeGuidance = registerDelegationGuidance(real, custom, 'ask_agent')
  try {
    for (const ptc of [false, true]) {
      const restore = real.tools.setExecutor({ describe: definitions => ({ schemas: ptc ? [{ name: 'run_code', parameters: { type: 'object' } }] : definitions.map(({ name, description, parameters }) => ({ name, description, parameters })) }) })
      for (enabled of [true, false]) {
        const toolSet = await real.tools.resolve({ agent: undefined, signal: new AbortController().signal })
        try {
          const result = await real.systemPrompt.assemble({ toolSet })
          const text = result.sections.map(s => s.text).join('\n')
          assert.equal(text.includes('from the `use_agent` roster'), enabled)
          assert.doesNotMatch(text, /Use `ask_agent`/)
          assert.equal(result.tools.some(t => t.name === 'run_code'), ptc)
        } finally { toolSet.dispose() }
      }
      restore()
    }
    console.log('delegation-guidance: PASS — real conditional ToolSet, native and PTC presentation')
  } finally { disposeGuidance(); await real.fiber.dispose() }
}
