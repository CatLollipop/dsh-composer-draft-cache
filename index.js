/**
 * Host half of the composer plugin bundle.
 *
 * The Client half lets the user `@`-mention an installed plugin in the composer.
 * This half makes that mention authoritative: on `agent/pre-step` it reads the
 * mention tokens from the messages entering the step, remembers the selected
 * plugin module names for that agent, and publishes their metadata as a bounded
 * runtime-context block through `ctx.systemPrompt.context()`. The model then
 * knows the user explicitly chose a plugin (and what it is) for this turn.
 *
 * `pluginInventory` is Remote-only on the Host, so metadata is read straight
 * from the Loader plus the optional `pluginPackages` display-metadata service,
 * mirroring what the inventory would answer for one module name.
 *
 * No durable session data is written: the injected block is the loop's own
 * runtime-context snapshot and is cleared/replaced by the same mechanism.
 */

import { pluginMentionsInMessages, renderPluginMentions } from './lib/mentions.js';

/** Required Host services. */
export const inject = ['loader', 'systemPrompt'];

/**
 * Pick a display string out of one metadata value.
 * @param {unknown} value - localized string, `{ en, ... }` map, or absent.
 * @returns {string | undefined}
 */
function displayText(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  if (typeof value.en === 'string') return value.en;
  for (const key of Object.keys(value)) if (typeof value[key] === 'string') return value[key];
  return undefined;
}

/**
 * Read live metadata for the mentioned module names.
 * @param {any} ctx - plugin context.
 * @param {string[]} names - mentioned module names.
 * @returns {Map<string, { entryId?: string, title?: string, description?: string }>}
 */
function lookupPlugins(ctx, names) {
  /** @type {Map<string, { entryId?: string, title?: string, description?: string }>} */
  const found = new Map();
  if (!Array.isArray(names) || names.length === 0) return found;
  let packages;
  try {
    packages = ctx.get('pluginPackages');
  } catch (error) {
    packages = undefined;
  }
  let entries;
  try {
    entries = ctx.loader.entries();
  } catch (error) {
    return found;
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const options = entry.options;
    if (options === null || typeof options !== 'object' || options.group === true) continue;
    const name = options.name;
    if (typeof name !== 'string' || !names.includes(name)) continue;
    if (entry.disabled === true) continue;
    let meta;
    try {
      const base = entry.parent && entry.parent.tree && entry.parent.tree.ctx
        ? entry.parent.tree.ctx.baseUrl
        : undefined;
      meta = base === undefined || packages === undefined || packages === null
        ? undefined
        : packages.metaOf(name, base);
    } catch (error) {
      meta = undefined;
    }
    const title = displayText(meta && meta.title);
    const description = displayText(meta && meta.description);
    found.set(name, {
      ...typeof entry.id === 'string' ? { entryId: entry.id } : {},
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
    });
  }
  return found;
}

/**
 * Install the plugin-mention runtime context.
 * @param {any} ctx - plugin context.
 */
export function apply(ctx) {
  /** Agent → module names selected in the turn currently entering the model. */
  const selected = new WeakMap();

  ctx.systemPrompt.context({
    name: 'composer:selected-plugins',
    order: 130,
    interpolate: false,
    text: (context) => {
      const agent = context === undefined || context === null ? undefined : context.agent;
      if (agent === undefined || agent === null) return '';
      const names = selected.get(agent);
      if (!Array.isArray(names) || names.length === 0) return '';
      try {
        const found = lookupPlugins(ctx, names);
        return renderPluginMentions(names, (name) => found.get(name));
      } catch (error) {
        return '';
      }
    },
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision === undefined || decision === null || decision.kind !== 'enter') return decision;
    try {
      const messages = decision.messages;
      const names = pluginMentionsInMessages(messages);
      if (names.length > 0) selected.set(payload.agent, names);
      else if (Array.isArray(messages) && messages.some((message) => message !== null && typeof message === 'object'
        && message.source !== null && typeof message.source === 'object' && message.source.kind === 'user')) {
        /* A new user message without a mention starts a fresh selection. Keep the
         * previous selection during later tool-call steps of the same turn. */
        selected.delete(payload.agent);
      }
    } catch (error) {
      /* Context injection is best-effort and must never block the step. */
    }
    return decision;
  }, { prepend: true });
}
