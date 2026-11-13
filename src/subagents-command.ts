/** Adapted from upstream v0.20.0 by caiqy: roster-only wizard; no template installation or PTC. */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Language } from './preset-contract.ts'
import { listAgentFiles, type AgentFile } from './agents-dir.ts'
import { currentDisabledAgents, type DisabledAgentsInput } from './tool-run-agent.ts'

// ---------------------------------------------------------------------------
// Structural seams (no host type imports — the shapes the command touches)
// ---------------------------------------------------------------------------

/** The one ask method the command needs (the language-ask seam shape). */
interface AskSeam {
  ask(request: {
    questions: AskQuestionItem[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers?: readonly AskAnswerItem[] }>
}

/** Structural ask question (mirrors AskUserQuestionItem's used fields). */
interface AskQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskOptionItem[]
  multiSelect?: boolean
}

interface AskOptionItem {
  label: string
  description?: string
}

/** Structural answer item (mirrors AskUserQuestionAnswerItem). */
interface AskAnswerItem {
  id?: unknown
  selected?: readonly string[]
  custom?: string
}

/** Structural command invocation (mirrors CommandInvocation's used fields). */
export interface SubagentsCommandInvocation {
  /** The live root agent the command ran against; scoped asks use it. */
  agent?: unknown
  rawInput: string
  signal: AbortSignal
}

/** Structural CommandResult (the two shapes a handler may return). */
export type SubagentsCommandResult =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

/** Structural settings surface: describe + mutate with a revision token. */
interface SettingsFormsLike {
  describe(): Array<{ ns: string; revision?: number; value?: unknown }>
  mutate(ns: string, ops: readonly SettingsPathOpLike[], expectedRevision?: number): Promise<void>
}

interface SettingsPathOpLike {
  op: 'set' | 'unset'
  path: readonly string[]
  value?: unknown
}

/** The plugin's settings namespace = the profile patch entry id. */
export const SUBAGENTS_SETTINGS_NAMESPACE = 'dsh-subagent-registry'

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

/** The wizard's string table (one entry per locale/<language>.json key). */
export interface SubagentsStrings {
  commandDescription: string
  askUnavailable: string
  askFailed: string
  manualHint: string
  qDisableHeader: string
  qDisableQuestion: string
  qDisableDetail: string
  markDisabled: string
  markEnabled: string
  noChanges: string
  savedHeader: string
  disabledLine: string
  enabledLine: string
  rosterRefreshed: string
  rosterRefreshFailed: string
  persistFailed: string
  settingsUnavailable: string
}

/** `{key}` interpolation over one locale string. */
function format(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole)
}

/** The English table doubles as the key whitelist and the last fallback. */
const EN_STRINGS: SubagentsStrings = {
  commandDescription: 'Manage subagents: enable or disable roster agents.',
  askUnavailable: 'No ask surface is available (the userQuestions service is not mounted). Edit the dsh-subagent-registry entry config manually (profile cordis.patch.yml or the settings page).',
  askFailed: 'The wizard could not complete ({error}). Configure manually, see below.',
  manualHint: 'Set disabledAgents (an array of disabled agent names) in the dsh-subagent-registry entry config (profile cordis.patch.yml or settings page). Agent files are never changed.',
  qDisableHeader: 'Disable agents',
  qDisableQuestion: 'Check the agents to disable (unchecked = enabled).',
  qDisableDetail: 'Disabling only hides an agent from the use_agent roster and refuses calls by name; the agent file is never modified. Currently disabled names must STAY checked to remain disabled.',
  markDisabled: 'currently disabled — keep checked to stay disabled, uncheck to re-enable',
  markEnabled: 'currently enabled — check to disable',
  noChanges: 'Nothing changed.',
  savedHeader: 'Subagent settings saved.',
  disabledLine: 'Disabled: {names}',
  enabledLine: 'Enabled: {names}',
  rosterRefreshed: 'Tool roster refreshed.',
  rosterRefreshFailed: 'Roster refresh failed: {error} — it applies when the management page is reopened or on the next dispatch.',
  persistFailed: 'Config write failed: {error}',
  settingsUnavailable: 'Settings service unavailable; no config was written.',
}

/** Directory of this compiled module (`<package root>/lib/`). */
function moduleDir(): string {
  return fileURLToPath(new URL('.', import.meta.url))
}

/** Absolute packaged locale file path for one language. */
function localeFilePath(language: string): string {
  return join(moduleDir(), '..', 'locale', `${language}.json`)
}

/**
 * Load the string table for one language from the packaged
 * `locale/<language>.json`. Any read/parse/shape failure falls back to the
 * English edition, then to the English constants (zh files keep the same key
 * set, so a missing zh section degrades to English rather than crash).
 */
export function loadSubagentsStrings(language: Language): SubagentsStrings {
  for (const candidate of [language, 'en'] as const) {
    try {
      const path = localeFilePath(candidate)
      if (!existsSync(path)) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { subagents?: Partial<SubagentsStrings> }
      const section = parsed.subagents
      if (section === undefined || typeof section !== 'object') continue
      // Keep only the known string keys (locale JSON may carry anything).
      const resolved: Partial<SubagentsStrings> = {}
      for (const key of Object.keys(EN_STRINGS) as Array<keyof SubagentsStrings>) {
        const value = section[key]
        if (typeof value === 'string' && value !== '') resolved[key] = value
      }
      return { ...EN_STRINGS, ...resolved }
    } catch {
      // Corrupt or unreadable file for one language: try the next fallback.
    }
  }
  return EN_STRINGS
}

// ---------------------------------------------------------------------------
// settings.mutate writer (the dsh-tui preference-write spell, structural)
// ---------------------------------------------------------------------------

/** Whether the error is the settings service's optimistic-concurrency refusal. */
function isSettingsConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
}

/**
 * Persist one batch of path ops into the plugin's entry config. Volatile-only
 * commits hot-swap the running disabledAgents references. A missing
 * settings service reports the failure; a conflict retries once against a
 * fresh revision.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeRegistryConfig(ctx: Context, ops: readonly SettingsPathOpLike[]): Promise<string | undefined> {
  const settings = (ctx as unknown as { get?(name: string): unknown }).get?.('settings') as SettingsFormsLike | undefined
  if (settings === undefined) return 'Settings service is not available.'
  for (let attempt = 0; ; attempt++) {
    try {
      const descriptor = settings.describe().find((d) => d.ns === SUBAGENTS_SETTINGS_NAMESPACE)
      await settings.mutate(SUBAGENTS_SETTINGS_NAMESPACE, ops, descriptor?.revision)
      return undefined
    } catch (error) {
      if (attempt === 0 && isSettingsConflict(error)) continue
      return error instanceof Error ? error.message : String(error)
    }
  }
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

/** Everything the command closes over; built once in `apply`. */
export interface SubagentsCommandDeps {
  ctx: Context
  /** The resolved (absolute) agents dir. */
  agentsDir: string
  language: Language
  /** The live `disabledAgents` value (volatile ref or plain array). */
  disabledAgents: DisabledAgentsInput
  /** The roster refresh the tool registration exposes. */
  refreshRoster: () => Promise<void>
}

/** Question id of the disable toggle (the answer echoes it back). */
export const DISABLE_QUESTION_ID = 'disable-agents'

/** Structural `ctx.commands.register` surface (guarded — older hosts omit it). */
interface CommandsSeam {
  register(definition: {
    name: string
    description: string
    handler: (invocation: SubagentsCommandInvocation) => Promise<SubagentsCommandResult>
  }): unknown
}

/** The host command name (satisfies the host's `/^[a-z][a-z0-9_-]*$/` rule). */
export const REGISTRY_CONFIG_COMMAND_NAME = 'registry-config'

/**
 * Register the `/registry-config` command on the host command registry. A
 * no-op on a host without the commands service (the dispatch surfaces degrade
 * to the manual config recipe documented in the README).
 *
 * Collision guard: the host keeps commands in per-scope `NamedEntries` tables
 * that THROW on a duplicate name (`command "X" is already registered …`), and
 * its listing API (`list` / `find`) is agent-scoped — it needs a receiving
 * agent this plugin does not have at mount time, so a pre-check is impossible.
 * The registration therefore runs inside a try/catch: a name already taken
 * (e.g. a host/tui twin registration) degrades to a `console.warn` and the
 * plugin keeps mounting — startup never explodes over a command name.
 */
export function registerSubagentsCommand(deps: SubagentsCommandDeps): void {
  // Read defensively through ctx.get: a property access (`ctx.commands`)
  // throws on an undeclared inject in cordis, and 'commands' stays off this
  // plugin's inject on purpose — a host without the service must keep
  // mounting (the command then degrades to the manual config recipe).
  const commands = (deps.ctx as unknown as { get?(name: string): unknown }).get?.('commands') as CommandsSeam | undefined
  if (commands === undefined || typeof commands.register !== 'function') return
  const strings = loadSubagentsStrings(deps.language)
  deps.ctx.effect(() => {
    // register() returns the disposer (same shape as ctx.tools.register) and
    // throws synchronously on a duplicate name. Wrap it: on any registration
    // refusal warn and skip (a stable no-op teardown) instead of failing the
    // effect — the host's duplicate throw must never take down TUI startup.
    let dispose: unknown
    try {
      dispose = commands.register({
        name: REGISTRY_CONFIG_COMMAND_NAME,
        description: strings.commandDescription,
        handler: (invocation) => handleSubagentsCommand(deps, invocation),
      }) as unknown
    } catch (error) {
      console.warn(
        `[dsh-subagent-registry] '/${REGISTRY_CONFIG_COMMAND_NAME}' command not registered: ` +
          `${error instanceof Error ? error.message : String(error)} — ` +
          'the name is likely taken by another plugin/host command; the wizard stays reachable via the manual config recipe (README).',
      )
      return () => {}
    }
    return () => {
      if (typeof dispose === 'function') (dispose as () => unknown)()
    }
  }, 'dsh-subagent-registry:/registry-config')
}

/** Build the disable-toggle question (roster snapshot + current state marks). */
export function buildDisableQuestion(
  strings: SubagentsStrings,
  agents: readonly AgentFile[],
  currentlyDisabled: readonly string[],
): AskQuestionItem {
  const disabled = new Set(currentlyDisabled)
  return {
    id: DISABLE_QUESTION_ID,
    header: strings.qDisableHeader,
    question: strings.qDisableQuestion,
    detail: strings.qDisableDetail,
    multiSelect: true,
    options: agents.map((agent) => ({
      label: agent.meta.name,
      description: disabled.has(agent.meta.name) ? strings.markDisabled : strings.markEnabled,
    })),
  }
}

/** The selected labels of one answered question; undefined when declined. */
function selectedOf(answers: readonly AskAnswerItem[] | undefined, id: string): readonly string[] | undefined {
  const item = answers?.find((candidate) => candidate.id === id)
  if (item === undefined) return undefined
  return Array.isArray(item.selected) ? item.selected : undefined
}

/** Ask, validate, persist, refresh, report. */
export async function handleSubagentsCommand(
  deps: SubagentsCommandDeps,
  invocation: SubagentsCommandInvocation,
): Promise<SubagentsCommandResult> {
  const strings = loadSubagentsStrings(deps.language)
  const ask = (deps.ctx as unknown as { get?(name: string): unknown }).get?.('userQuestions') as AskSeam | undefined
  if (ask === undefined || typeof ask.ask !== 'function') {
    return { kind: 'error', text: `${strings.askUnavailable}\n\n${strings.manualHint}` }
  }

  // Snapshot the roster + current toggle state for the questions.
  const { agents } = listAgentFiles(deps.agentsDir)
  const currentDisabled = [...currentDisabledAgents(deps.disabledAgents)]
  const questions: AskQuestionItem[] = []
  if (agents.length > 0) {
    questions.push(buildDisableQuestion(strings, agents, currentDisabled))
  }
  if (questions.length === 0) return { kind: 'success', text: strings.noChanges }

  let answers: readonly AskAnswerItem[] | undefined
  try {
    const reply = await ask.ask({
      questions,
      ...(invocation.agent !== undefined ? { agent: invocation.agent } : {}),
      signal: invocation.signal,
    })
    answers = reply.answers
  } catch (error) {
    // NO_PROVIDER (headless, no answerer) or an aborted/failed ask: degrade to
    // the manual recipe instead of a raw error dump.
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `${format(strings.askFailed, { error: detail })}\n\n${strings.manualHint}` }
  }

  // A declined panel (no answer rows at all) changes nothing.
  const disableSelected = selectedOf(answers, DISABLE_QUESTION_ID)
  if (disableSelected === undefined) {
    return { kind: 'success', text: strings.noChanges }
  }

  // Only names in the displayed roster can be changed; preserve disabled names
  // whose files are currently missing or invalid. Reject unknown selections.
  const names = new Set(agents.map(agent => agent.meta.name))
  if (disableSelected.some(name => !names.has(name))) return { kind: 'error', text: strings.askFailed.replace('{error}', 'Unknown agent selection') }
  const desiredDisabled = new Set([...currentDisabled.filter(name => !names.has(name)), ...disableSelected])

  // Persist only the changed disabled-agent list.
  const ops: SettingsPathOpLike[] = []
  const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
    const left = [...a].sort()
    const right = [...b].sort()
    return left.length === right.length && left.every((v, i) => v === right[i])
  }
  if (!sameSet(desiredDisabled, currentDisabled)) {
    // Stable order: keep the current list's order for surviving entries, then
    // append additions.
    const merged = [...currentDisabled.filter((name) => desiredDisabled.has(name))]
    for (const name of desiredDisabled) {
      if (!merged.includes(name)) merged.push(name)
    }
    ops.push({ op: 'set', path: ['disabledAgents'], value: merged })
  }
  if (ops.length > 0) {
    const persistMessage = await writeRegistryConfig(deps.ctx, ops)
    if (persistMessage !== undefined) {
      return {
        kind: 'error',
        text: `${format(strings.persistFailed, { error: persistMessage })}\n\n${strings.manualHint}`,
      }
    }
  }

  // Report. The desired-vs-current diff drives the summary lines; an answer
  // that repeats the current state is a reported no-op (nothing was written,
  // so no refresh is triggered either).
  const newlyDisabled = [...desiredDisabled].filter((name) => !currentDisabled.includes(name)).sort()
  const newlyEnabled = currentDisabled.filter((name) => !desiredDisabled.has(name)).sort()
  if (ops.length === 0) return { kind: 'success', text: strings.noChanges }

  // Apply the hot toggle to the tool descriptions (the volatile write swapped
  // the value in place; the refresh just re-reads it). Best-effort.
  const notes: string[] = [strings.savedHeader]
  try {
    await deps.refreshRoster()
    notes.push(strings.rosterRefreshed)
  } catch (error) {
    notes.push(format(strings.rosterRefreshFailed, { error: error instanceof Error ? error.message : String(error) }))
  }
  if (newlyDisabled.length > 0) notes.push(format(strings.disabledLine, { names: newlyDisabled.join(', ') }))
  if (newlyEnabled.length > 0) notes.push(format(strings.enabledLine, { names: newlyEnabled.join(', ') }))
  return { kind: 'success', text: notes.join('\n') }
}
