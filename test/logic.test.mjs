/**
 * Headless verification for the composer draft cache client half.
 *
 * The plugin ships as a browser module (`window.__ModuleLoader__.load`), so this
 * test loads the real `client.js` text in a `vm` sandbox with a minimal React
 * hook dispatcher and fake Slot/session services. It drives the component
 * through the scenarios the feature exists for:
 *
 *   new-session box, cached per workspace
 *     1. stash a draft, switch workspace, get it back
 *     2. keep each workspace's draft separate
 *     3. drop the entry after the new-session message is sent
 *     4. drop a deliberately cleared draft (it must not bounce back)
 *     5. never restore a draft whose source new Session already started
 *     6. never refill a reused blank Session that already attempted a prompt,
 *        yet keep another still-blank Session's entry
 *
 *   already-created ("historical") Sessions, cached per Session
 *     7. stash a draft, switch Session/workspace, get it back
 *     8. keep each Session's draft separate
 *     9. drop a draft once it is sent, so it never returns to the input box
 *    10. drop a draft the user deliberately cleared
 *    11. cache a draft even before the workspace path resolves
 *
 *   lifetime
 *    12. survive a page reload through the sessionStorage mirror
 *    13. fall back to the Session cwd when the workspace list is empty
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client.js');
const clientSource = readFileSync(clientPath, 'utf8');

const PREFIX = 'dsh.composer-draft-cache.v1:';

/** sessionStorage stub shared by module generations, like a real page reload. */
function createStorage() {
  const data = new Map();
  return {
    data,
    getItemCalls: 0,
    setItemCalls: 0,
    removeItemCalls: 0,
    getItem(key) {
      this.getItemCalls += 1;
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      this.setItemCalls += 1;
      data.set(key, String(value));
    },
    removeItem(key) {
      this.removeItemCalls += 1;
      data.delete(key);
    },
  };
}

/** Minimal hook dispatcher: only useRef/useEffect are needed by this component. */
function createReactStub() {
  let active = null;
  return {
    useRef(initial) {
      const renderer = active;
      const index = renderer.cursor++;
      if (renderer.hookState[index] === undefined) renderer.hookState[index] = { current: initial };
      return renderer.hookState[index];
    },
    useEffect(fn, deps) {
      const renderer = active;
      const index = renderer.cursor++;
      renderer.effects.push({ index, fn, deps });
    },
    setActive(renderer) {
      active = renderer;
    },
  };
}

function sameDeps(prev, next) {
  if (prev === undefined || next === undefined) return false;
  if (prev.length !== next.length) return false;
  for (let index = 0; index < prev.length; index += 1) {
    if (!Object.is(prev[index], next[index])) return false;
  }
  return true;
}

function createRenderer(component, getProps, react) {
  const hookState = [];
  const renderer = {
    cursor: 0,
    effects: [],
    hookState,
    render() {
      renderer.cursor = 0;
      renderer.effects = [];
      react.setActive(renderer);
      try {
        component(getProps());
      } finally {
        react.setActive(null);
      }
      for (const effect of renderer.effects) {
        const previous = hookState[effect.index];
        const changed = previous === undefined || previous.deps === undefined || !sameDeps(previous.deps, effect.deps);
        hookState[effect.index] = { current: previous?.current, deps: effect.deps };
        if (changed) effect.fn();
      }
    },
  };
  return renderer;
}

/** Load one module generation of the client bundle. */
function loadClientGeneration(options) {
  const registrations = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (spec) => registrations.push(spec),
      },
    },
    sessionStorage: options.storage,
    console: { log() {}, warn() {}, error() {} },
    Map,
    Set,
    Symbol,
    Array,
    Object,
    JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: clientPath });
  assert.equal(registrations.length, 1, 'client.js must register exactly one module');
  const spec = registrations[0];
  assert.equal(typeof spec.factory, 'function', 'module must expose a lazy factory');
  return spec.factory((id) => {
    assert.equal(id, 'react', 'client.js may only require react');
    return options.react;
  });
}

/**
 * Create the plugin under test and return a handle that can mount one Session.
 * @param {{storage: object, snapshots: object}} options
 */
function createPlugin(options) {
  const react = createReactStub();
  const mod = loadClientGeneration({ storage: options.storage, react });
  const snapshots = options.snapshots;
  const registrations = [];
  const sources = [];
  const rules = [];
  const localeDicts = [];
  const inventory = { entries: [] };
  const staleSources = Array.isArray(options.staleSources) ? options.staleSources : [];
  const ctx = {
    get(name) {
      if (name === 'sessions') return { list: { getSnapshot: () => snapshots.sessions } };
      if (name === 'uiConversation') {
        return {
          userText: {
            register(rule) {
              rules.push(rule);
              return () => {};
            },
          },
        };
      }
      if (name === 'inputTriggers') {
        return {
          registerSource(source) {
            if (staleSources.includes(source.name)) throw new Error(`slash source "@${source.name}" is already registered`);
            sources.push(source);
            return () => {};
          },
        };
      }
      return undefined;
    },
    locale: {
      register(namespace, dicts) {
        localeDicts.push({ namespace, dicts });
        return () => {};
      },
      bind() {
        return (key) => ({ 'section.plugins': '插件' }[key] ?? key);
      },
      getSnapshot() {
        return { id: 'zh' };
      },
    },
    remote: {
      pluginInventory: {
        async list() {
          return { ok: true, value: { entries: inventory.entries } };
        },
      },
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject(name, callback) {
        return callback();
      },
      register(optionsIn, Component) {
        registrations.push({ options: optionsIn, Component });
        return () => {};
      },
    },
  };
  if (options.inventory !== undefined && Array.isArray(options.inventory.entries)) {
    inventory.entries = options.inventory.entries;
  }
  mod.apply(ctx);
  assert.equal(typeof mod.apply, 'function');
  const dock = registrations.find((entry) => entry.options.name === 'conversation.input.dock');
  assert.ok(dock !== undefined, 'apply() must register the dock entry');
  assert.equal(dock.options.id, 'composer-draft-cache');
  const Component = dock.Component;

  const props = {
    get sessionId() {
      return snapshots.sessionId;
    },
    useSession(selector) {
      return selector(snapshots.session);
    },
    useSessions(selector) {
      return selector(snapshots.sessions);
    },
    useWorkspaces(selector) {
      return selector(snapshots.workspaces);
    },
    useInput(selector) {
      return selector(snapshots.input);
    },
    inputActions: {
      setDraft(text) {
        setDraftCalls += 1;
        snapshots.input = { ...snapshots.input, draft: text };
      },
    },
  };

  const renderer = createRenderer(Component, () => props, react);
  let setDraftCalls = 0;

  return {
    get setDraftCalls() {
      return setDraftCalls;
    },
    /** Mount or re-render the component with the current snapshots. */
    render() {
      renderer.render();
    },
    /** Simulate the user typing into the composer (a store publish). */
    type(text) {
      snapshots.input = { ...snapshots.input, draft: text };
      renderer.render();
    },
    /** Simulate the user sending the draft: Enter clears the composer. */
    send() {
      snapshots.input = { ...snapshots.input, draft: '' };
      renderer.render();
    },
    /** Simulate switching to another Session, optionally in another workspace. */
    open(sessionId, workspacePath, blank = true, sessionExtra = undefined) {
      snapshots.sessionId = sessionId;
      snapshots.session = sessionExtra === undefined ? { blank } : { ...sessionExtra, blank };
      snapshots.sessions = {
        byId: {
          ...snapshots.sessions.byId,
          [sessionId]: { cwd: workspacePath, blank },
        },
      };
      snapshots.workspaces = workspacePath === undefined
        ? { items: [] }
        : {
            items: [
              {
                workspaceId: `ws:${workspacePath}`,
                path: workspacePath,
                sessionIds: Object.keys(snapshots.sessions.byId).filter(
                  (id) => snapshots.sessions.byId[id].cwd === workspacePath,
                ),
              },
            ],
          };
      snapshots.input = { draft: '', attachmentIds: [], phase: 'plain' };
      renderer.render();
    },
    /** Mark a Session as started without rendering another Session (host-side fact). */
    markStarted(sessionId) {
      const summary = snapshots.sessions.byId[sessionId];
      if (summary !== undefined) summary.blank = false;
    },
    /** True when the composer currently holds the given text. */
    shows(text) {
      return snapshots.input.draft === text;
    },
    /** Client module inject list (services the client half waits for). */
    injectList: mod.inject,
    /** Registered `@` completion source by name. */
    sourceFor(name) {
      const source = sources.find((entry) => entry.trigger === '@' && entry.name === name);
      assert.ok(source !== undefined, `@ source "${name}" must be registered`);
      return source;
    },
    /** The source that publishes candidates (the first free name). */
    primarySource() {
      const source = sources.find((entry) => entry.trigger === '@');
      assert.ok(source !== undefined, 'at least one @ source must be registered');
      return source;
    },
    /** Every registered @ source name, in registration order. */
    sourceNames() {
      return sources.filter((entry) => entry.trigger === '@').map((entry) => entry.name);
    },
    /** Run the primary plugin source's candidate lookup for one query. */
    async pluginCandidates(query = '') {
      return this.primarySource().candidates({ sessionId: 's-1' }, {
        query,
        quoted: false,
        drilled: false,
        signal: undefined,
      });
    },
    /** Run the primary plugin source's pick handler for one candidate row. */
    pluginPick(row) {
      return this.primarySource().onPick({ candidate: { value: row.value }, action: 'pick' });
    },
    /** Match the @plugin sent-message rule against text. */
    pluginRuleMatch(text) {
      const rule = rules.find((entry) => entry.id === 'plugin');
      assert.ok(rule !== undefined, 'the @plugin user-text rule must be registered');
      return rule.match(text, 0);
    },
    /** The registered sent-message renderer for @plugin mentions. */
    pluginRenderer() {
      return registrations.find((entry) => entry.options.name === 'conversation.user.text.node'
        && entry.options.key === 'plugin');
    },
    /** Locale dictionaries registered for the plugin namespace. */
    localeDicts,
  };
}

function baseSnapshots() {
  return {
    sessionId: 's-init',
    session: { blank: true },
    sessions: { byId: { 's-init': { cwd: '/work/A', blank: true } } },
    workspaces: { items: [{ workspaceId: 'ws:A', path: '/work/A', sessionIds: ['s-init'] }] },
    input: { draft: '', attachmentIds: [], phase: 'plain' },
  };
}

test('new-session: stashes a draft and restores it after a workspace round-trip', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('a1', '/work/A');
  plugin.type('draft for A');
  assert.equal(JSON.parse(storage.data.get(`${PREFIX}workspace:/work/A`)).text, 'draft for A');

  plugin.open('b1', '/work/B');
  plugin.type('draft for B');
  assert.equal(JSON.parse(storage.data.get(`${PREFIX}workspace:/work/B`)).text, 'draft for B');

  plugin.open('a2', '/work/A');
  assert.equal(plugin.shows('draft for A'), true, 'Workspace A new-session draft must be restored');
  assert.equal(
    JSON.parse(storage.data.get(`${PREFIX}workspace:/work/B`)).text,
    'draft for B',
    'Workspace B is untouched',
  );

  plugin.open('b2', '/work/B');
  assert.equal(plugin.shows('draft for B'), true, 'Workspace B new-session draft must be restored');
});

test('new-session: sending the message consumes the workspace cache', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('a1', '/work/A');
  plugin.type('send me');
  plugin.send();
  // A default send keeps the Session blank for a beat: the emptied composer
  // must not be refilled with the text that was just submitted.
  assert.equal(plugin.shows(''), true, 'sent text must not bounce back while the Session is still blank');
  assert.equal(storage.data.has(`${PREFIX}workspace:/work/A`), false);

  plugin.markStarted('a1');
  snapshots.session = { blank: false };
  plugin.render();

  plugin.open('a2', '/work/A');
  assert.equal(plugin.shows(''), true, 'a sent new-session draft must not come back');
});

test('new-session: a deliberately cleared draft does not bounce back', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('a1', '/work/A');
  plugin.type('typed then cleared');
  plugin.type('');
  assert.equal(plugin.shows(''), true, 'one clear must leave the composer empty');
  assert.equal(storage.data.has(`${PREFIX}workspace:/work/A`), false);
});

test('new-session: a remount after an attempted prompt never refills', () => {
  const storage = createStorage();
  const first = baseSnapshots();
  const firstPlugin = createPlugin({ storage, snapshots: first });
  firstPlugin.open('a1', '/work/A');
  firstPlugin.type('submitted before the remount');

  // New module generation (remount/reload): the cache entry still exists, and the
  // blank Session already attempted its first prompt, so the draft was submitted.
  const second = baseSnapshots();
  const secondPlugin = createPlugin({ storage, snapshots: second });
  secondPlugin.open('a1', '/work/A', true, { promptAttempted: true });
  assert.equal(secondPlugin.shows(''), true, 'an attempted prompt must not be refilled');
  assert.equal(storage.data.has(`${PREFIX}workspace:/work/A`), false);
});

test('new-session: a prompt-attempted reused blank keeps another blank Session entry', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  snapshots.sessions = {
    byId: {
      's-init': { cwd: '/work/A', blank: true },
      orphan: { cwd: '/work/A', blank: true },
    },
  };
  storage.data.set(
    `${PREFIX}workspace:/work/A`,
    JSON.stringify({ text: 'other blank draft', session: 'orphan' }),
  );
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('reused', '/work/A', true, { promptAttempted: true });
  assert.equal(plugin.shows(''), true, 'must not restore into the reused blank Session');
  assert.equal(
    storage.data.get(`${PREFIX}workspace:/work/A`),
    JSON.stringify({ text: 'other blank draft', session: 'orphan' }),
    "the other blank Session's unsent entry is kept",
  );
});

test('new-session: a source Session that already started is never restored', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  // The draft is stashed in Workspace A's new-session box.
  plugin.open('a1', '/work/A');
  plugin.type('submitted elsewhere');
  // The user moves away before the composer publishes its cleared state, then
  // the Session finishes its first message (it is no longer blank).
  plugin.markStarted('a1');
  plugin.open('a2', '/work/A');
  assert.equal(plugin.shows(''), true, 'an already-started source must not refill');
  assert.equal(storage.data.has(`${PREFIX}workspace:/work/A`), false, 'the stale entry is discarded');
});

test('historical Session: stashes a draft and restores it after switching away', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('h1', '/work/A', false);
  plugin.type('unsent historical draft');

  plugin.open('h2', '/work/A', false);
  plugin.open('h1', '/work/A', false);
  assert.equal(plugin.shows('unsent historical draft'), true, 'returning to the Session restores its draft');
});

test('historical Session: each Session keeps its own draft', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('h1', '/work/A', false);
  plugin.type('one');
  plugin.open('h2', '/work/A', false);
  plugin.type('two');

  plugin.open('h1', '/work/A', false);
  assert.equal(plugin.shows('one'), true);
  plugin.open('h2', '/work/A', false);
  assert.equal(plugin.shows('two'), true);
});

test('historical Session: a sent draft is dropped and never returns', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('h1', '/work/A', false);
  plugin.type('already sent');
  plugin.send();
  assert.equal(plugin.shows(''), true, 'sent text must not bounce back into the input box');

  plugin.open('h2', '/work/A', false);
  plugin.open('h1', '/work/A', false);
  assert.equal(plugin.shows(''), true, 'sent text must not reappear in the input box');
  assert.equal(storage.data.has(`${PREFIX}session:h1`), false);
});

test('historical Session: a deliberately cleared draft does not bounce back', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('h1', '/work/A', false);
  plugin.type('typed then cleared');
  plugin.type('');
  assert.equal(plugin.shows(''), true, 'one clear must leave the input box empty');
  assert.equal(storage.data.has(`${PREFIX}session:h1`), false);

  plugin.open('h2', '/work/A', false);
  plugin.open('h1', '/work/A', false);
  assert.equal(plugin.shows(''), true);
});

test('historical Session: caches even before the workspace path resolves', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  plugin.open('h1', undefined, false);
  plugin.type('no workspace path yet');
  assert.equal(storage.data.get(`${PREFIX}session:h1`), 'no workspace path yet');

  plugin.open('h2', undefined, false);
  plugin.open('h1', '/work/A', false);
  assert.equal(plugin.shows('no workspace path yet'), true);
});

test('page reload keeps both cache kinds through sessionStorage', () => {
  const storage = createStorage();
  const first = baseSnapshots();
  const firstPlugin = createPlugin({ storage, snapshots: first });
  firstPlugin.open('a1', '/work/A');
  firstPlugin.type('new-session draft');
  firstPlugin.open('h1', '/work/A', false);
  firstPlugin.type('historical draft');

  const second = baseSnapshots();
  const secondPlugin = createPlugin({ storage, snapshots: second });
  secondPlugin.open('a2', '/work/A');
  assert.equal(secondPlugin.shows('new-session draft'), true);
  secondPlugin.open('h1', '/work/A', false);
  assert.equal(secondPlugin.shows('historical draft'), true);
});

test('falls back to the Session cwd when the workspace list has no items yet', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  snapshots.sessionId = 'c1';
  snapshots.session = { blank: true };
  snapshots.sessions = { byId: { c1: { cwd: '/work/C', blank: true } } };
  snapshots.workspaces = { items: [] };
  snapshots.input = { draft: '', attachmentIds: [], phase: 'plain' };
  plugin.render();
  plugin.type('cwd fallback');
  assert.equal(JSON.parse(storage.data.get(`${PREFIX}workspace:/work/C`)).text, 'cwd fallback');

  snapshots.sessionId = 'c2';
  snapshots.session = { blank: true };
  snapshots.sessions = { byId: { c2: { cwd: '/work/C', blank: true } } };
  snapshots.input = { draft: '', attachmentIds: [], phase: 'plain' };
  plugin.render();
  assert.equal(plugin.shows('cwd fallback'), true);
});

test('perf: unrelated composer publishes do not re-run the cache effect', () => {
  const storage = createStorage();
  const snapshots = baseSnapshots();
  const plugin = createPlugin({ storage, snapshots });

  // Historical Session with a saved draft.
  plugin.open('h1', '/work/A', false);
  plugin.type('stable draft');
  const setItems = storage.setItemCalls;
  const removeItems = storage.removeItemCalls;
  const setDrafts = plugin.setDraftCalls;

  // 300 publishes that only change unrelated InputState fields (queue/occurrences).
  for (let index = 0; index < 300; index += 1) {
    snapshots.input = { ...snapshots.input, queue: [{ id: index }], occurrences: [] };
    plugin.render();
  }
  assert.equal(storage.setItemCalls, setItems, 'no redundant sessionStorage writes');
  assert.equal(storage.removeItemCalls, removeItems, 'no redundant sessionStorage removals');
  assert.equal(plugin.setDraftCalls, setDrafts, 'no redundant restore writes');

  // The empty new-session composer stays quiet too.
  plugin.open('a1', '/work/A');
  const removesAfterOpen = storage.removeItemCalls;
  for (let index = 0; index < 300; index += 1) {
    snapshots.input = { ...snapshots.input, queue: [{ id: index }] };
    plugin.render();
  }
  assert.equal(storage.removeItemCalls, removesAfterOpen, 'a blank composer must not touch storage per publish');
});

/* ------------------------------------------------------------------ *
 * @plugin mentions (client half)
 * ------------------------------------------------------------------ */

function pluginInventory(entries) {
  return { entries };
}

test('@plugin: candidates list only enabled community plugins, localized', async () => {
  const plugin = createPlugin({
    storage: createStorage(),
    snapshots: baseSnapshots(),
    inventory: pluginInventory([
      { entryId: 'include:ui-theme', moduleName: '@deepseek-ai/dsh-client-ui-theme', enabled: true, fiberPhase: 'active', meta: { title: 'Theme' } },
      {
        entryId: 'include:claude-style',
        moduleName: 'dsh-claude-style',
        enabled: true,
        fiberPhase: 'active',
        meta: {
          title: { en: 'Claude style', zh: 'Claude 风格' },
          description: { en: 'A theme', zh: '一个主题' },
        },
      },
      { entryId: 'include:disabled', moduleName: 'dsh-disabled', enabled: false, fiberPhase: null },
      { entryId: 'include:loading', moduleName: 'dsh-loading', enabled: true, fiberPhase: 'loading' },
      { entryId: 'include:root', moduleName: 'cordis:include', enabled: true, fiberPhase: 'active' },
    ]),
  });

  const rows = await plugin.pluginCandidates('');
  assert.equal(rows.length, 1, 'core, disabled and non-active entries are not selectable plugins');
  assert.equal(rows[0].name, 'Claude 风格');
  assert.equal(rows[0].description, 'dsh-claude-style');
  assert.equal(rows[0].section, '插件');
  assert.deepEqual(JSON.parse(rows[0].value), {
    kind: 'plugin',
    moduleName: 'dsh-claude-style',
    title: 'Claude 风格',
  });
});

test('@plugin: the menu query filters by title, module name and description', async () => {
  const plugin = createPlugin({
    storage: createStorage(),
    snapshots: baseSnapshots(),
    inventory: pluginInventory([
      {
        entryId: 'include:claude-style',
        moduleName: 'dsh-claude-style',
        enabled: true,
        fiberPhase: 'active',
        meta: { title: { en: 'Claude style', zh: 'Claude 风格' }, description: { en: 'A theme', zh: '一个主题' } },
      },
      {
        entryId: 'include:better-sidebar',
        moduleName: 'dsh-better-sidebar',
        enabled: true,
        fiberPhase: 'active',
        meta: { title: { en: 'Better sidebar', zh: '更好的侧栏' }, description: { en: 'Sidebar', zh: '侧栏' } },
      },
    ]),
  });

  const byTitle = await plugin.pluginCandidates('Claude');
  assert.equal(byTitle.length, 1);
  assert.equal(JSON.parse(byTitle[0].value).moduleName, 'dsh-claude-style');

  const byModule = await plugin.pluginCandidates('sidebar');
  assert.equal(byModule.length, 1);
  assert.equal(JSON.parse(byModule[0].value).moduleName, 'dsh-better-sidebar');

  const byDescription = await plugin.pluginCandidates('主题');
  assert.equal(byDescription.length, 1);
  assert.equal(JSON.parse(byDescription[0].value).moduleName, 'dsh-claude-style');

  assert.equal((await plugin.pluginCandidates('nothing-matches')).length, 0);
});

test('@plugin: a pick inserts an atomic mention chip', async () => {
  const plugin = createPlugin({
    storage: createStorage(),
    snapshots: baseSnapshots(),
    inventory: pluginInventory([
      {
        entryId: 'include:claude-style',
        moduleName: 'dsh-claude-style',
        enabled: true,
        fiberPhase: 'active',
        meta: { title: { en: 'Claude style', zh: 'Claude 风格' } },
      },
    ]),
  });

  const rows = await plugin.pluginCandidates('');
  const pick = plugin.pluginPick(rows[0]);
  assert.equal(pick.insert.source, 'plugin');
  assert.equal(pick.insert.label, 'Claude 风格');
  assert.equal(pick.insert.ref, '@[Claude 风格](dsh-plugin:dsh-claude-style)');
  assert.equal(pick.insert.clipboardText, pick.insert.ref);

  const source = plugin.sourceFor('plugin');
  assert.equal(await source.codec.serialize(pick.insert.ref), pick.insert.ref);
  assert.equal(source.codec.clipboardText(pick.insert.ref), pick.insert.ref);
});

test('@plugin: sent messages expose canonical and hand-typed mentions', () => {
  const plugin = createPlugin({ storage: createStorage(), snapshots: baseSnapshots() });

  const canonical = '@[Claude 风格](dsh-plugin:dsh-claude-style)';
  const first = plugin.pluginRuleMatch(`use ${canonical} now`);
  assert.equal(first.id, 'plugin');
  assert.equal(first.start, 4);
  assert.equal(first.end, 4 + canonical.length);
  assert.equal(first.data.label, 'Claude 风格');
  assert.equal(first.data.name, 'dsh-claude-style');

  const second = plugin.pluginRuleMatch('hi @plugin:dsh-better-sidebar');
  assert.equal(second.start, 3);
  assert.equal(second.data.name, 'dsh-better-sidebar');
  assert.equal(second.data.label, undefined);

  assert.notEqual(plugin.pluginRenderer(), undefined, 'the @plugin text renderer must be registered');
  assert.equal(plugin.injectList.includes('inputTriggers'), true);
  assert.equal(plugin.injectList.includes('remote.pluginInventory'), true);
  assert.equal(plugin.injectList.includes('uiConversation'), true);
});

test('@plugin: falls back to the next source name when a stale generation owns one', async () => {
  const plugin = createPlugin({
    storage: createStorage(),
    snapshots: baseSnapshots(),
    staleSources: ['plugin', 'plugins'],
    inventory: pluginInventory([
      {
        entryId: 'include:claude-style',
        moduleName: 'dsh-claude-style',
        enabled: true,
        fiberPhase: 'active',
        meta: { title: { en: 'Claude style', zh: 'Claude 风格' } },
      },
    ]),
  });

  assert.deepEqual(plugin.sourceNames(), ['plugin-mentions']);
  const rows = await plugin.pluginCandidates('');
  assert.equal(rows.length, 1);
  const pick = plugin.pluginPick(rows[0]);
  assert.equal(pick.insert.source, 'plugin-mentions');
  assert.equal(pick.insert.ref, '@[Claude 风格](dsh-plugin:dsh-claude-style)');
});

test('@plugin: a clean load registers the primary name and quiet aliases', async () => {
  const plugin = createPlugin({ storage: createStorage(), snapshots: baseSnapshots() });
  assert.equal(plugin.sourceNames()[0], 'plugin');
  for (const name of plugin.sourceNames().slice(1)) {
    const alias = plugin.sourceFor(name);
    assert.equal((await alias.candidates({}, { query: '', signal: undefined })).length, 0);
    assert.equal(alias.codec.clipboardText('x'), 'x');
  }
});
