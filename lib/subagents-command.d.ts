import type { Context } from '@deepseek-ai/cordis';
import type { Language } from './preset-contract.ts';
import { type AgentFile } from './agents-dir.ts';
import { type DisabledAgentsInput } from './tool-run-agent.ts';
/** Structural ask question (mirrors AskUserQuestionItem's used fields). */
interface AskQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: AskOptionItem[];
    multiSelect?: boolean;
}
interface AskOptionItem {
    label: string;
    description?: string;
}
/** Structural command invocation (mirrors CommandInvocation's used fields). */
export interface SubagentsCommandInvocation {
    /** The live root agent the command ran against; scoped asks use it. */
    agent?: unknown;
    rawInput: string;
    signal: AbortSignal;
}
/** Structural CommandResult (the two shapes a handler may return). */
export type SubagentsCommandResult = {
    kind: 'success';
    text?: string;
} | {
    kind: 'error';
    text: string;
};
interface SettingsPathOpLike {
    op: 'set' | 'unset';
    path: readonly string[];
    value?: unknown;
}
/** The plugin's settings namespace = the profile patch entry id. */
export declare const SUBAGENTS_SETTINGS_NAMESPACE = "dsh-subagent-registry";
/** The wizard's string table (one entry per locale/<language>.json key). */
export interface SubagentsStrings {
    commandDescription: string;
    askUnavailable: string;
    askFailed: string;
    manualHint: string;
    qDisableHeader: string;
    qDisableQuestion: string;
    qDisableDetail: string;
    markDisabled: string;
    markEnabled: string;
    noChanges: string;
    savedHeader: string;
    disabledLine: string;
    enabledLine: string;
    rosterRefreshed: string;
    rosterRefreshFailed: string;
    persistFailed: string;
    settingsUnavailable: string;
}
/**
 * Load the string table for one language from the packaged
 * `locale/<language>.json`. Any read/parse/shape failure falls back to the
 * English edition, then to the English constants (zh files keep the same key
 * set, so a missing zh section degrades to English rather than crash).
 */
export declare function loadSubagentsStrings(language: Language): SubagentsStrings;
/**
 * Persist one batch of path ops into the plugin's entry config. Volatile-only
 * commits hot-swap the running disabledAgents references. A missing
 * settings service reports the failure; a conflict retries once against a
 * fresh revision.
 * @returns undefined on success, the failure message otherwise.
 */
export declare function writeRegistryConfig(ctx: Context, ops: readonly SettingsPathOpLike[]): Promise<string | undefined>;
/** Everything the command closes over; built once in `apply`. */
export interface SubagentsCommandDeps {
    ctx: Context;
    /** The resolved (absolute) agents dir. */
    agentsDir: string;
    language: Language;
    /** The live `disabledAgents` value (volatile ref or plain array). */
    disabledAgents: DisabledAgentsInput;
    /** The roster refresh the tool registration exposes. */
    refreshRoster: () => Promise<void>;
}
/** Question id of the disable toggle (the answer echoes it back). */
export declare const DISABLE_QUESTION_ID = "disable-agents";
/** The host command name (satisfies the host's `/^[a-z][a-z0-9_-]*$/` rule). */
export declare const REGISTRY_CONFIG_COMMAND_NAME = "registry-config";
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
export declare function registerSubagentsCommand(deps: SubagentsCommandDeps): void;
/** Build the disable-toggle question (roster snapshot + current state marks). */
export declare function buildDisableQuestion(strings: SubagentsStrings, agents: readonly AgentFile[], currentlyDisabled: readonly string[]): AskQuestionItem;
/** Ask, validate, persist, refresh, report. */
export declare function handleSubagentsCommand(deps: SubagentsCommandDeps, invocation: SubagentsCommandInvocation): Promise<SubagentsCommandResult>;
export {};
