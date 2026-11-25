import { PRESETS_CHANNEL, PRESETS_ENDPOINT_PREFIX } from "./preset-contract.js";
import { createPresetStore, validateId } from "./preset-store.js";
import { writeRegistryConfig } from "./subagents-command.js";
import { currentDisabledAgents } from "./tool-run-agent.js";
/** Public exact Connection routes inherit the /api authentication and Host/Origin fence. */
export async function registerPresetsRpc(ctx, directory, refreshRoster, getLanguage, disabledAgents) {
    const store = createPresetStore(directory);
    const { clientRequestSchema } = await import('@deepseek-ai/dsh-client-connection');
    let pendingToggle = Promise.resolve();
    const serialToggle = (operation) => {
        const result = pendingToggle.then(operation);
        pendingToggle = result.then(() => undefined, () => undefined);
        return result;
    };
    const hasSettings = () => {
        const settings = ctx.get?.('settings');
        return typeof settings?.describe === 'function' && typeof settings?.mutate === 'function';
    };
    const togglePreset = (payload) => serialToggle(async () => {
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(payload))) {
            throw Object.assign(new Error('Expected an object'), { code: 'invalid_input' });
        }
        for (const key of Reflect.ownKeys(payload)) {
            if (typeof key !== 'string' || (key !== 'id' && key !== 'enabled')) {
                throw Object.assign(new Error(`Unknown field: ${String(key)}`), { code: 'invalid_input', field: String(key) });
            }
        }
        const raw = payload;
        validateId(raw.id);
        if (typeof raw.enabled !== 'boolean') {
            throw Object.assign(new Error('Expected a boolean'), { code: 'invalid_input', field: 'enabled' });
        }
        const id = raw.id;
        const enabled = raw.enabled;
        const { entries } = await store.list();
        if (!entries.some(entry => entry.id === id)) {
            throw Object.assign(new Error(`Preset "${id}" does not exist`), { code: 'not_found', field: 'id' });
        }
        if (!hasSettings()) {
            throw Object.assign(new Error('Settings service is not available.'), { code: 'settings_unavailable' });
        }
        const current = [...currentDisabledAgents(disabledAgents)];
        const next = enabled
            ? current.filter(name => name !== id)
            : (current.includes(id) ? current : [...current, id]);
        const changed = next.length !== current.length || next.some((name, index) => name !== current[index]);
        if (changed) {
            const failure = await writeRegistryConfig(ctx, [{ op: 'set', path: ['disabledAgents'], value: next }]);
            if (failure !== undefined) {
                throw Object.assign(new Error(failure), { code: 'settings_write_failed' });
            }
        }
        return { id, enabled, disabledAgents: next };
    });
    for (const endpoint of ['list', 'save', 'remove', 'toggle']) {
        const method = `${PRESETS_ENDPOINT_PREFIX}${endpoint}`;
        // rpc.handle captures the provider's shadow context, which cannot read webServer
        // on either supported SDK. Exact Connection routes use the existing authenticated bridge.
        ctx.connection.fetch.register({
            path: `${PRESETS_CHANNEL}/${method}`, methods: ['POST'], requestBody: 'buffered',
            async fetch(request) {
                if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
                    return new Response('expected application/json', { status: 415 });
                let raw;
                try {
                    raw = await request.json();
                }
                catch {
                    return new Response('invalid JSON', { status: 400 });
                }
                const envelope = clientRequestSchema.safeParse(raw);
                if (!envelope.success || envelope.data.method !== method)
                    return new Response('invalid RPC envelope', { status: 400 });
                let reply;
                try {
                    request.signal.throwIfAborted();
                    const payload = envelope.data.payload;
                    let value;
                    if (endpoint === 'list') {
                        if (payload !== null && payload !== undefined)
                            throw Object.assign(new Error('列表请求不接受参数'), { code: 'invalid_input' });
                        value = {
                            ...(await store.list()),
                            language: getLanguage(),
                            disabledAgents: [...currentDisabledAgents(disabledAgents)],
                            canToggle: hasSettings(),
                        };
                    }
                    else if (endpoint === 'save')
                        value = await store.save(payload);
                    else if (endpoint === 'toggle')
                        value = await togglePreset(payload);
                    else {
                        await store.remove(payload);
                        value = null;
                    }
                    // A completed file operation stays committed even if the request is then cancelled.
                    try {
                        await refreshRoster();
                    }
                    catch (error) {
                        throw Object.assign(new Error(`文件操作已完成，但名册刷新失败，请刷新重试：${error instanceof Error ? error.message : String(error)}`), { code: 'roster_refresh_failed' });
                    }
                    reply = { ok: true, value };
                }
                catch (error) {
                    const detail = error instanceof Error ? error : new Error(String(error));
                    const code = 'code' in detail && typeof detail.code === 'string' ? detail.code : 'io_error';
                    const field = 'field' in detail && typeof detail.field === 'string' ? detail.field : undefined;
                    reply = { ok: false, error: detail.message, code, ...(field === undefined ? {} : { field }) };
                }
                return Response.json({ type: 'server-response', rpcId: envelope.data.rpcId, result: { ok: true, value: reply } });
            },
        });
    }
}
//# sourceMappingURL=presets-rpc.js.map