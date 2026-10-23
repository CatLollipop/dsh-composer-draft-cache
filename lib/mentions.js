/**
 * Pure parsing/rendering helpers for `@plugin:` composer mentions.
 *
 * The Client half inserts an atomic mention chip whose serialized form is either
 * the canonical Markdown mention `@[Title](dsh-plugin:<module name>)` or the
 * hand-typed shortcut `@plugin:<module name>`. The Host half runs these helpers
 * on the messages entering a step and turns them into a bounded runtime-context
 * block that tells the model which installed plugin the user explicitly picked.
 *
 * Kept free of Cordis/agent types so the rules are testable in isolation.
 */

/** Canonical mention: `@[Label](dsh-plugin:<module-name>)`. */
const CANONICAL_RE = /@\[([^\]\n]{0,200})\]\(dsh-plugin:([A-Za-z0-9@/._-]+)\)/gu;

/** Hand-typed shortcut: `@plugin:<module-name>`. */
const SHORTCUT_RE = /@plugin:([A-Za-z0-9@/._-]+)/gu;

/** Module names this feature accepts (npm package specifiers, no whitespace). */
const MODULE_NAME_RE = /^[A-Za-z0-9@/._-]+$/u;

/** Upper bound on distinct plugins honoured from one message. */
export const MAX_PLUGIN_MENTIONS = 8;

/**
 * Collect the plugin module names mentioned in one text block, in order.
 * @param {string} text - one model-visible text block.
 * @returns {string[]} distinct module names, in mention order.
 */
export function pluginMentionsInText(text) {
  if (typeof text !== 'string' || text === '') return [];
  const names = [];
  for (const match of text.matchAll(CANONICAL_RE)) {
    const name = match[2];
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name);
  }
  for (const match of text.matchAll(SHORTCUT_RE)) {
    const name = match[1];
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Collect plugin mentions from the text blocks of one user message.
 * @param {{ source?: { kind?: string }, content?: unknown[] }} message - UserMessage candidate.
 * @returns {string[]} distinct module names, in mention order.
 */
export function pluginMentionsInMessage(message) {
  if (message === null || typeof message !== 'object') return [];
  const source = message.source;
  if (source === null || typeof source !== 'object' || source.kind !== 'user') return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'text') continue;
    for (const name of pluginMentionsInText(block.text)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Collect mentions from every user message of one step, capped and deduplicated.
 * @param {unknown[]} messages - messages accepted for the step.
 * @returns {string[]} distinct module names, in mention order.
 */
export function pluginMentionsInMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const names = [];
  for (const message of messages) {
    for (const name of pluginMentionsInMessage(message)) {
      if (names.includes(name)) continue;
      names.push(name);
      if (names.length >= MAX_PLUGIN_MENTIONS) return names;
    }
  }
  return names;
}

/**
 * @typedef {object} PluginInfo
 * @property {string} [title] - localized display title.
 * @property {string} [description] - localized one-line description.
 * @property {string} [entryId] - live Loader entry id.
 * @property {boolean} [installed] - false when no enabled entry matches.
 */

/**
 * Render the runtime-context block for the given mentions.
 * @param {string[]} names - distinct module names in mention order.
 * @param {(name: string) => PluginInfo | undefined} lookup - installed plugin lookup.
 * @returns {string} context text, or '' when nothing was mentioned.
 */
export function renderPluginMentions(names, lookup) {
  if (!Array.isArray(names) || names.length === 0) return '';
  const lines = [];
  for (const name of names) {
    if (typeof name !== 'string' || !MODULE_NAME_RE.test(name)) continue;
    let info;
    try {
      info = lookup(name);
    } catch (error) {
      info = undefined;
    }
    if (info === undefined || info === null) {
      lines.push(`- \`${name}\`: not installed or not enabled in this profile.`);
      continue;
    }
    const title = typeof info.title === 'string' && info.title.trim() !== '' ? info.title.trim() : name;
    const facts = [`\`${name}\``];
    if (typeof info.entryId === 'string' && info.entryId !== '') facts.push(`Loader entry \`${info.entryId}\``);
    const description = typeof info.description === 'string' ? info.description.trim() : '';
    lines.push(`- **${title}** (${facts.join('; ')})${description === '' ? '.' : `: ${description}`}`);
  }
  if (lines.length === 0) return '';
  return [
    '## User-selected plugins (@plugin mentions)',
    'The current user message explicitly mentions installed DeepSeek Harness plugins through `@plugin` mentions. Treat each mention as the user asking you to use that plugin\'s capabilities for this task: its tools, skills, commands, or UI features where they apply. Do not invent capabilities a listed plugin does not provide; if a selected plugin has nothing useful for the request, say so briefly instead of pretending to use it.',
    '',
    ...lines,
    '',
    'Mention syntax in the message: `@[Title](dsh-plugin:<module name>)` or `@plugin:<module name>`.',
  ].join('\n');
}
