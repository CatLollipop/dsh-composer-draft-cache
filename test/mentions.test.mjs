/**
 * Host-half verification for `@plugin` mentions.
 *
 * Two layers are exercised without a running Harness:
 *  - the pure helpers in `lib/mentions.js` (token parsing, bounded rendering);
 *  - `index.js` itself against a stub Cordis context: the registered
 *    `systemPrompt.context` provider and the `agent/pre-step` listener are
 *    driven exactly the way the agent loop drives them, proving that a mention
 *    becomes a bounded runtime-context block for that agent and is cleared on
 *    the next user message without a mention.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PLUGIN_MENTIONS,
  pluginMentionsInMessage,
  pluginMentionsInMessages,
  pluginMentionsInText,
  renderPluginMentions,
} from '../lib/mentions.js';
import { apply, inject } from '../index.js';

/* ------------------------------ parsing ------------------------------ */

test('parses canonical and hand-typed mentions in order, deduplicated', () => {
  const text = 'use @[Claude 风格](dsh-plugin:dsh-claude-style) and @plugin:dsh-better-sidebar, '
    + 'also @plugin:dsh-claude-style again';
  assert.deepEqual(pluginMentionsInText(text), ['dsh-claude-style', 'dsh-better-sidebar']);
});

test('ignores text that is not a plugin mention', () => {
  assert.deepEqual(pluginMentionsInText(''), []);
  assert.deepEqual(pluginMentionsInText('@[label](dsh-session:abc) and @file.ts'), []);
  assert.deepEqual(pluginMentionsInText('@plugin:'), []);
  // A bare token ends at whitespace, like every other inline token.
  assert.deepEqual(pluginMentionsInText('@plugin:has space'), ['has']);
});

test('collects mentions from user messages only', () => {
  const user = {
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'please @plugin:alpha' }, { type: 'image' }, { type: 'text', text: 'and @plugin:beta' }],
  };
  assert.deepEqual(pluginMentionsInMessages([user]), ['alpha', 'beta']);
  assert.deepEqual(pluginMentionsInMessage({ source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '@plugin:alpha' }] }), []);
  assert.deepEqual(pluginMentionsInMessages([null, {}, { source: { kind: 'user' }, content: 'not-an-array' }]), []);
});

test('caps the number of distinct mentions', () => {
  const names = Array.from({ length: MAX_PLUGIN_MENTIONS + 4 }, (_, index) => `plugin-${index}`);
  const text = names.map((name) => `@plugin:${name}`).join(' ');
  assert.equal(pluginMentionsInText(text).length, names.length);
  assert.equal(pluginMentionsInMessages([{ source: { kind: 'user' }, content: [{ type: 'text', text }] }]).length, MAX_PLUGIN_MENTIONS);
});

/* ------------------------------ rendering ------------------------------ */

test('renders installed metadata and unknown mentions', () => {
  const text = renderPluginMentions(['dsh-claude-style', 'not-installed'], (name) => (name === 'dsh-claude-style' ? {
    title: 'Claude 风格',
    description: '一个主题',
    entryId: 'include:claude-style',
  } : undefined));

  assert.match(text, /^## User-selected plugins \(@plugin mentions\)/u);
  assert.match(text, /explicitly mentions installed DeepSeek Harness plugins/u);
  assert.match(text, /\*\*Claude 风格\*\* \(`dsh-claude-style`; Loader entry `include:claude-style`\): 一个主题/u);
  assert.match(text, /`not-installed`: not installed or not enabled in this profile\./u);
});

test('renders nothing without mentions and survives a throwing lookup', () => {
  assert.equal(renderPluginMentions([], () => undefined), '');
  const text = renderPluginMentions(['dsh-x'], () => {
    throw new Error('loader broke');
  });
  assert.match(text, /`dsh-x`: not installed or not enabled/u);
});

/* --------------------------- plugin wiring --------------------------- */

/**
 * Drive `index.js` with a stub context the way the agent loop does.
 * @returns {{provider: any, preStep: any, ctx: any}}
 */
function createHostPlugin() {
  const contexts = [];
  const listeners = [];
  const entries = [
    {
      id: 'include:claude-style',
      options: { name: 'dsh-claude-style' },
      disabled: false,
      parent: { tree: { ctx: { baseUrl: '/profile' } } },
    },
    {
      id: 'include:better-sidebar',
      options: { name: 'dsh-better-sidebar' },
      disabled: false,
      parent: { tree: { ctx: { baseUrl: '/profile' } } },
    },
    {
      id: 'include:disabled',
      options: { name: 'dsh-disabled' },
      disabled: true,
      parent: { tree: { ctx: { baseUrl: '/profile' } } },
    },
  ];
  const ctx = {
    systemPrompt: {
      context(entry) {
        contexts.push(entry);
        return () => {};
      },
    },
    on(event, listener, options) {
      listeners.push({ event, listener, options });
      return () => {};
    },
    get(name) {
      if (name !== 'pluginPackages') return undefined;
      return {
        metaOf(name) {
          return {
            title: { en: name === 'dsh-better-sidebar' ? 'Better sidebar' : 'Claude style' },
            description: { en: `${name} description` },
          };
        },
      };
    },
    loader: {
      entries() {
        return entries;
      },
    },
  };
  apply(ctx);
  const provider = contexts.find((entry) => entry.name === 'composer:selected-plugins');
  const preStep = listeners.find((entry) => entry.event === 'agent/pre-step');
  assert.ok(provider !== undefined, 'the runtime-context provider must be registered');
  assert.ok(preStep !== undefined, 'the agent/pre-step listener must be registered');
  assert.equal(preStep.options && preStep.options.prepend, true, 'the listener must run outermost');
  return { provider, preStep, ctx };
}

test('host plugin declares its services and injects selected plugin metadata', async () => {
  assert.deepEqual(inject, ['loader', 'systemPrompt']);
  const { provider, preStep } = createHostPlugin();
  const agent = { session: { id: 's-1' } };
  assert.equal(provider.text({ agent }), '', 'no mention yet means no context');

  const decision = {
    kind: 'enter',
    messages: [{
      source: { kind: 'user' },
      content: [{ type: 'text', text: '做 UI/UE 设计，使用 @plugin:dsh-claude-style' }],
    }],
  };
  const returned = await preStep.listener({ agent, messages: decision.messages, turn: 1, step: 1 }, async () => decision);
  assert.equal(returned, decision, 'the decision itself must be handed through unchanged');

  const text = provider.text({ agent });
  assert.match(text, /\*\*Claude style\*\* \(`dsh-claude-style`; Loader entry `include:claude-style`\): dsh-claude-style description/u);

  // A later tool-call step of the same turn carries no new user message: the
  // selection must stay visible.
  await preStep.listener({ agent, messages: [], turn: 1, step: 2 }, async () => ({ kind: 'enter', messages: [] }));
  assert.match(provider.text({ agent }), /dsh-claude-style/u);

  // The next user message without a mention starts a fresh selection.
  const next = {
    kind: 'enter',
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }],
  };
  await preStep.listener({ agent, messages: next.messages, turn: 2, step: 1 }, async () => next);
  assert.equal(provider.text({ agent }), '', 'a new message without a mention clears the selection');
});

test('host plugin keeps per-agent selections apart and tolerates unknown plugins', async () => {
  const { provider, preStep } = createHostPlugin();
  const first = { session: { id: 's-1' } };
  const second = { session: { id: 's-2' } };
  const decision = (text) => ({ kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] });

  await preStep.listener({ agent: first, messages: [] }, async () => decision('@plugin:dsh-better-sidebar'));
  await preStep.listener({ agent: second, messages: [] }, async () => decision('@plugin:dsh-disabled and @plugin:ghost'));

  assert.match(provider.text({ agent: first }), /Better sidebar/u);
  assert.doesNotMatch(provider.text({ agent: first }), /Claude style/u);
  const secondText = provider.text({ agent: second });
  assert.match(secondText, /`dsh-disabled`: not installed or not enabled/u);
  assert.match(secondText, /`ghost`: not installed or not enabled/u);
  assert.equal(provider.text({ agent: { session: { id: 's-3' } } }), '', 'unknown agents read no context');
});

test('host plugin never blocks a rejected step', async () => {
  const { preStep } = createHostPlugin();
  const rejected = { kind: 'reject', reason: 'blocked' };
  const returned = await preStep.listener({ agent: {}, messages: [] }, async () => rejected);
  assert.equal(returned, rejected);
});
