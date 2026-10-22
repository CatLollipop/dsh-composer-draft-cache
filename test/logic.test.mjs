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
  let registered = null;
  const ctx = {
    get(name) {
      if (name === 'sessions') return { list: { getSnapshot: () => snapshots.sessions } };
      return undefined;
    },
    slots: {
      inject(name, callback) {
        return callback();
      },
      register(optionsIn, Component) {
        registered = { options: optionsIn, Component };
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  assert.ok(registered !== null, 'apply() must register the dock entry');
  assert.equal(registered.options.name, 'conversation.input.dock');
  assert.equal(registered.options.id, 'composer-draft-cache');

  const Component = registered.Component;

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
