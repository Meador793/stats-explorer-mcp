// Asking the user to confirm the selections an AI model made (columns, groups, chart types, report
// sections) before anything runs. On by default.
//
// 1. If the client supports MCP elicitation, the user sees a form with the model's choices pre-filled
//    as dropdowns / checkboxes, can change them, and accepts or declines.
// 2. Otherwise the tool returns "needs_confirmation" with the proposal and a one-time token. The model
//    must show the proposal to the user and call again with the same choices plus that token. A
//    token only matches the exact selection it was issued for, so a changed selection is re-proposed.
import { randomBytes } from 'node:crypto';
import { UserError } from './data.js';

/**
 * field: { key, title, type: 'select' | 'multiselect' | 'number' | 'text' | 'boolean',
 *          value, options?: string[], description?, min?, max? }
 */
const canonical = (kind, values) => JSON.stringify([kind, Object.keys(values).sort().map((k) => [k, values[k]])]);
const MULTI_AS_CHECKBOXES = 25;
const safeKey = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);

function toElicitSchema(fields) {
  const properties = {};
  const map = []; // [propertyName, field, option?]
  for (const f of fields) {
    const base = { title: f.title, ...(f.description ? { description: f.description } : {}) };
    if (f.type === 'select') {
      properties[f.key] = { type: 'string', ...base, enum: f.options, default: f.value };
      map.push([f.key, f]);
    } else if (f.type === 'multiselect') {
      if (f.options.length <= MULTI_AS_CHECKBOXES) {
        f.options.forEach((opt, i) => {
          const name = `${f.key}__${i}_${safeKey(opt)}`;
          properties[name] = { type: 'boolean', title: `${f.title}: ${opt}`, default: f.value.includes(opt) };
          map.push([name, f, opt]);
        });
      } else {
        properties[f.key] = { type: 'string', ...base, description: `${f.description || ''} Comma-separated.`.trim(), default: f.value.join(', ') };
        map.push([f.key, f]);
      }
    } else if (f.type === 'number') {
      properties[f.key] = { type: 'number', ...base, default: f.value, ...(f.min != null ? { minimum: f.min } : {}), ...(f.max != null ? { maximum: f.max } : {}) };
      map.push([f.key, f]);
    } else if (f.type === 'boolean') {
      properties[f.key] = { type: 'boolean', ...base, default: !!f.value };
      map.push([f.key, f]);
    } else {
      properties[f.key] = { type: 'string', ...base, default: f.value ?? '' };
      map.push([f.key, f]);
    }
  }
  return { schema: { type: 'object', properties }, map };
}

function readElicitAnswer(content, fields, map) {
  const values = Object.fromEntries(fields.map((f) => [f.key, f.type === 'multiselect' ? [] : f.value]));
  for (const [name, f, opt] of map) {
    const v = content?.[name];
    if (f.type === 'multiselect') {
      if (opt !== undefined) { if (v === true || (v === undefined && f.value.includes(opt))) values[f.key].push(opt); }
      else values[f.key] = String(v ?? f.value.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (v !== undefined && v !== null && v !== '') values[f.key] = f.type === 'number' ? Number(v) : v;
  }
  for (const f of fields) {
    if (f.type === 'select' && !f.options.includes(values[f.key])) throw new UserError(`"${values[f.key]}" is not a valid choice for ${f.title}.`);
    if (f.type === 'multiselect') for (const v of values[f.key]) if (!f.options.includes(v)) throw new UserError(`"${v}" is not a valid choice for ${f.title}.`);
    if (f.type === 'number' && !Number.isFinite(values[f.key])) throw new UserError(`${f.title} must be a number.`);
  }
  return values;
}

function describeValue(f, v) {
  if (f.type === 'multiselect') return v.length ? v.join(', ') : '(none)';
  if (f.type === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/**
 * Returns { ok: true, values } when the user approved (possibly after changing choices),
 * or { ok: false, result } with a tool result to return as-is (needs confirmation / declined).
 */
export async function confirmSelection(ctx, { kind, intro, fields, token }) {
  const { session, server } = ctx;
  const proposed = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  if (!session.config.confirmSelections) return { ok: true, values: proposed };

  const key = canonical(kind, proposed);
  if (session.confirmed.has(key)) return { ok: true, values: proposed };

  const lines = fields.map((f) => `- ${f.title}: ${describeValue(f, f.value)}`);

  if (server?.getClientCapabilities?.()?.elicitation) {
    const { schema, map } = toElicitSchema(fields);
    try {
      const res = await server.elicitInput({ message: `${intro}\n\nCheck these choices. Change any that are wrong, then accept.`, requestedSchema: schema });
      if (res.action !== 'accept') {
        return { ok: false, result: { summary: [`The user ${res.action === 'decline' ? 'declined' : 'cancelled'} the confirmation, so nothing was run. Ask what they would like to change.`], data: { status: 'not_confirmed', action: res.action } } };
      }
      const values = readElicitAnswer(res.content || {}, fields, map);
      session.confirmed.add(canonical(kind, values));
      return { ok: true, values, changedByUser: canonical(kind, values) !== key };
    } catch (e) {
      if (e instanceof UserError) throw e;
      // Client advertised elicitation but the request failed: fall back to the token flow.
      console.error('Elicitation failed, falling back to token confirmation:', e?.message || e);
    }
  }

  if (token && session.pending.get(token) === key) {
    session.pending.delete(token);
    session.confirmed.add(key);
    return { ok: true, values: proposed };
  }
  const newToken = randomBytes(4).toString('hex');
  session.pending.set(newToken, key);
  const options = fields.filter((f) => f.options).map((f) => `  ${f.title} options: ${f.options.slice(0, 40).join(', ')}${f.options.length > 40 ? ', …' : ''}`);
  return {
    ok: false,
    result: {
      summary: [
        'CONFIRMATION NEEDED, nothing has run yet.',
        intro,
        ...lines,
        ...(options.length ? ['Other choices available:', ...options] : []),
        `Show these choices to the user in plain words and ask them to confirm or change them. Only after the user agrees, call this tool again with the same arguments plus confirmation_token: "${newToken}". If they change anything, call again with the new choices (you will get a new token). Do not confirm on the user's behalf.`,
      ],
      data: { status: 'needs_confirmation', kind, proposed, options: Object.fromEntries(fields.filter((f) => f.options).map((f) => [f.key, f.options])), confirmation_token: newToken },
    },
  };
}
