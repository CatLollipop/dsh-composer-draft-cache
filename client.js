window.__ModuleLoader__.load({
  id: 'dsh-composer-draft-cache',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');

    /**
     * Composer draft cache (UI enhancement).
     *
     * Two related losses are covered:
     *
     * 1. A Workspace's "new session" action opens a fresh blank Session, so text
     *    typed into that composer is detached from the Session that showed it
     *    once the user switches to another workspace's conversation.
     * 2. A Session's own draft is normally restored by the per-Session store, but
     *    this client half keeps an independent copy as well, so an unsent draft in
     *    an already-created ("historical") Session survives workspace switches and
     *    page reloads even when that store cannot help.
     *
     * A draft is only put back into an empty composer on a Session mount before
     * that mount has seen any text. Once this mount has observed text, an empty
     * composer means the draft was sent or deliberately cleared: the entry is
     * deleted and never restored, so submitted content never returns to the input
     * box. A new-session entry is additionally discarded when its source blank
     * Session has already started (`promptAttempted`) or is no longer blank.
     *
     * Storage is browser-lifetime only: an in-memory map plus a sessionStorage
     * mirror (survives a page reload, cleared when the window closes). Nothing is
     * written to the Host or to the Session log.
     */

    const STORAGE_PREFIX = 'dsh.composer-draft-cache.v1:';
    const NAME = 'dsh-composer-draft-cache-client';
    const DOCK_ENTRY_ID = 'composer-draft-cache';
    const WORKSPACE_KEY_PREFIX = 'workspace:';
    const SESSION_KEY_PREFIX = 'session:';

    /** In-memory cache for the current page; sessionStorage only mirrors it. */
    const memoryCache = new Map();

    function readStorage(key) {
      try {
        if (typeof sessionStorage === 'undefined') return undefined;
        const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
        return typeof raw === 'string' ? raw : undefined;
      } catch (error) {
        return undefined;
      }
    }

    function writeStorage(key, value) {
      try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.setItem(STORAGE_PREFIX + key, value);
      } catch (error) {
        /* storage may be unavailable or full; the in-memory cache still works */
      }
    }

    function removeStorage(key) {
      try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.removeItem(STORAGE_PREFIX + key);
      } catch (error) {
        /* ignore */
      }
    }

    /** @param {string} key @returns {string | undefined} */
    function cacheGet(key) {
      const memory = memoryCache.get(key);
      if (memory !== undefined) return memory;
      const stored = readStorage(key);
      if (stored !== undefined) memoryCache.set(key, stored);
      return stored;
    }

    /** @param {string} key @param {string} value */
    function cacheSet(key, value) {
      if (memoryCache.get(key) === value) return;
      memoryCache.set(key, value);
      writeStorage(key, value);
    }

    /** @param {string} key */
    function cacheDelete(key) {
      memoryCache.delete(key);
      removeStorage(key);
    }

    function isFunction(value) {
      return typeof value === 'function';
    }

    /** Selector used when a standard hook is absent; keeps the hook call count stable. */
    function absentSelector() {
      return undefined;
    }

    /** @param {unknown} value @returns {value is string} */
    function isNonEmptyString(value) {
      return typeof value === 'string' && value !== '';
    }

    /**
     * New-session entries remember which blank Session produced the draft so a
     * later restore can tell whether that draft was already submitted.
     * @param {string} text
     * @param {string} sessionId
     * @returns {string}
     */
    function encodeWorkspaceDraft(text, sessionId) {
      return JSON.stringify({ text: text, session: sessionId });
    }

    /**
     * @param {string | undefined} raw
     * @returns {{ text: string, session: string | undefined } | undefined}
     */
    function decodeWorkspaceDraft(raw) {
      if (raw === undefined) return undefined;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return { text: parsed, session: undefined };
        if (parsed === null || typeof parsed !== 'object') return undefined;
        if (typeof parsed.text !== 'string') return undefined;
        return {
          text: parsed.text,
          session: typeof parsed.session === 'string' ? parsed.session : undefined,
        };
      } catch (error) {
        return undefined;
      }
    }

    /* ------------------------------------------------------------------ *
     * @plugin mentions
     *
     * The composer already opens an `@` menu for files and Sessions. This
     * module registers one more `@` source that lists installed community
     * plugins, inserts an atomic mention chip, and renders the same mention in
     * sent messages. The Host half detects the token in the accepted user
     * message and injects the selected plugin's metadata as runtime context,
     * so the model knows the user explicitly chose that plugin.
     * ------------------------------------------------------------------ */

    /** Locale namespace for the menu/renderer strings. */
    const NS = 'composer-draft-cache';
    /** Canonical model form: `@[Title](dsh-plugin:<module name>)`. */
    const MENTION_PREFIX = 'dsh-plugin:';
    /** npm-style module names accepted in a mention token. */
    const MODULE_NAME_RE = /^[A-Za-z0-9@/._-]+$/u;
    /** Keep one inventory snapshot for a few seconds; filtering happens locally. */
    const PLUGIN_CACHE_TTL_MS = 3000;
    let pluginRowCache;

    const DICT_ZH = {
      'section.plugins': '插件',
    };
    const DICT_EN = {
      'section.plugins': 'Plugins',
    };

    /** Localized display string from metadata (`string` or `{ en, ... }`). @param {unknown} value @param {string} localeId @returns {string | undefined} */
    function localizedText(value, localeId) {
      if (typeof value === 'string') return value;
      if (value === null || typeof value !== 'object') return undefined;
      if (typeof value[localeId] === 'string') return value[localeId];
      if (typeof value.en === 'string') return value.en;
      for (const key of Object.keys(value)) if (typeof value[key] === 'string') return value[key];
      return undefined;
    }

    /** Active locale id, `en` when the locale service cannot answer. @param {any} ctx @returns {string} */
    function currentLocaleId(ctx) {
      try {
        const snapshot = ctx.locale.getSnapshot();
        if (snapshot !== null && typeof snapshot === 'object') {
          if (typeof snapshot.id === 'string') return snapshot.id;
          if (typeof snapshot.active === 'string') return snapshot.active;
        }
      } catch (error) {
        /* fall through */
      }
      return 'en';
    }

    /** Whether one inventory entry is an enabled community plugin worth mentioning. @param {any} entry @returns {boolean} */
    function isSelectablePlugin(entry) {
      if (entry === null || typeof entry !== 'object') return false;
      if (entry.enabled !== true || entry.fiberPhase !== 'active') return false;
      const name = entry.moduleName;
      if (typeof name !== 'string' || name === '') return false;
      if (name.startsWith('@deepseek-ai/')) return false;
      if (name === 'include' || name.startsWith('cordis:') || name.startsWith('cordis-')) return false;
      return MODULE_NAME_RE.test(name);
    }

    /** Resolve the client remotes service; dotted inject declarations do not grant the `remote` property. @param {any} ctx @returns {any} */
    function remoteOf(ctx) {
      try {
        const remote = ctx.remote;
        if (remote !== undefined && remote !== null) return remote;
      } catch (error) {
        /* property access is gated by inject; fall back to optional lookup */
      }
      try {
        if (typeof ctx.get === 'function') {
          const remote = ctx.get('remote');
          if (remote !== undefined && remote !== null) return remote;
        }
      } catch (error) {
        /* optional lookup unavailable */
      }
      return undefined;
    }

    /** Read the mention token for one plugin. @param {string} title @param {string} moduleName @returns {string} */
    function pluginMentionToken(title, moduleName) {
      const safe = String(title === undefined || title === null ? moduleName : title)
        .replace(/[\[\]\n\r]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
      return `@[${safe === '' ? moduleName : safe}](${MENTION_PREFIX}${moduleName})`;
    }

    /**
     * Installed plugins available for `@` completion, from the Host inventory.
     * @param {any} ctx - client context.
     * @param {AbortSignal | undefined} signal - completion cancellation.
     * @returns {Promise<Array<{ moduleName: string, title: string, description?: string }>>}
     */
    async function loadPluginRows(ctx, signal) {
      const now = Date.now();
      if (pluginRowCache !== undefined && now - pluginRowCache.at < PLUGIN_CACHE_TTL_MS) return pluginRowCache.rows;
      const remote = remoteOf(ctx);
      const inventory = remote === undefined || remote === null ? undefined : remote.pluginInventory;
      if (inventory === undefined || inventory === null || !isFunction(inventory.list)) return [];
      const result = await inventory.list();
      if (signal !== undefined && signal.aborted) return [];
      if (result === undefined || result === null || result.ok !== true) return [];
      const entries = result.value !== null && typeof result.value === 'object' && Array.isArray(result.value.entries)
        ? result.value.entries
        : [];
      const localeId = currentLocaleId(ctx);
      const rows = [];
      const seen = new Set();
      for (const entry of entries) {
        if (!isSelectablePlugin(entry)) continue;
        const moduleName = entry.moduleName;
        if (seen.has(moduleName)) continue;
        seen.add(moduleName);
        const meta = entry.meta !== null && typeof entry.meta === 'object' ? entry.meta : undefined;
        const title = localizedText(meta === undefined ? undefined : meta.title, localeId);
        const description = localizedText(meta === undefined ? undefined : meta.description, localeId);
        rows.push({
          moduleName,
          title: title === undefined || title === '' ? moduleName : title,
          ...description === undefined ? {} : { description },
        });
      }
      rows.sort((left, right) => left.title.localeCompare(right.title));
      pluginRowCache = { at: now, rows };
      return rows;
    }

    /** Translator bound to the plugin namespace, falling back to the key. @param {any} ctx @returns {(key: string) => string} */
    function createTranslator(ctx) {
      try {
        return ctx.locale.bind(NS);
      } catch (error) {
        return (key) => key;
      }
    }

    /** Source names tried in order; the first free one publishes the menu group. */
    const SOURCE_NAMES = ['plugin', 'plugins', 'plugin-mentions'];

    /**
     * One `@` completion source. Only the first free name publishes candidates;
     * extra free names register as quiet aliases so a chip inserted under any of
     * them keeps a serializer across page reloads.
     * @param {any} ctx - client context.
     * @param {string} sourceName - the name this source registers under.
     * @param {boolean} primary - whether this source publishes menu candidates.
     * @returns {any} the source object consumed by `inputTriggers.registerSource`.
     */
    function createPluginSource(ctx, sourceName, primary) {
      const t = createTranslator(ctx);
      return {
        trigger: '@',
        name: sourceName,
        order: 10,
        showGroupTitle: false,
        async candidates(_session, request) {
          if (primary !== true) return [];
          const signal = request === undefined || request === null ? undefined : request.signal;
          const query = request === undefined || request === null || typeof request.query !== 'string'
            ? ''
            : request.query.trim();
          let rows;
          try {
            rows = await loadPluginRows(ctx, signal);
          } catch (error) {
            return [];
          }
          if (signal !== undefined && signal.aborted) return [];
          const needle = query.toLocaleLowerCase();
          const filtered = needle === '' ? rows : rows.filter((row) => row.moduleName.toLocaleLowerCase().includes(needle)
            || row.title.toLocaleLowerCase().includes(needle)
            || (row.description === undefined ? false : row.description.toLocaleLowerCase().includes(needle)));
          const section = t('section.plugins');
          return filtered.slice(0, 30).map((row) => ({
            name: row.title,
            description: row.moduleName,
            section,
            value: JSON.stringify({ kind: 'plugin', moduleName: row.moduleName, title: row.title }),
          }));
        },
        onPick(pick) {
          const candidate = pick === undefined || pick === null ? undefined : pick.candidate;
          if (candidate === undefined || candidate === null || typeof candidate.value !== 'string') return undefined;
          let value;
          try {
            value = JSON.parse(candidate.value);
          } catch (error) {
            return undefined;
          }
          if (value === null || typeof value !== 'object' || value.kind !== 'plugin') return undefined;
          if (typeof value.moduleName !== 'string' || !MODULE_NAME_RE.test(value.moduleName)) return undefined;
          const title = typeof value.title === 'string' && value.title !== '' ? value.title : value.moduleName;
          const mention = pluginMentionToken(title, value.moduleName);
          return {
            insert: {
              source: sourceName,
              ref: mention,
              label: title,
              clipboardText: mention,
            },
          };
        },
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve(ref),
        },
      };
    }

    /**
     * Sent-message renderer for one `@plugin` mention: a compact inline chip.
     * @param {{ node?: { data?: { label?: string, name?: string } }, raw?: string }} props
     * @returns {any}
     */
    function PluginMentionText(props) {
      const data = props !== undefined && props.node !== undefined ? props.node.data : undefined;
      const label = data !== undefined && typeof data.label === 'string' && data.label !== '' ? data.label : '';
      const name = data !== undefined && typeof data.name === 'string' ? data.name : '';
      const text = label === '' ? (name === '' ? 'plugin' : name) : label;
      return React.createElement('span', {
        title: name === '' ? text : `${text} · ${name}`,
        style: {
          color: 'var(--dsw-alias-state-business-primary)',
          background: 'var(--dsw-alias-state-business-tertiary)',
          borderRadius: 'var(--dsw-radius-sm)',
          padding: '0 4px',
          whiteSpace: 'nowrap',
        },
      }, React.createElement('span', { 'aria-hidden': true, style: { marginRight: '2px', fontWeight: 500 } }, '@'), text);
    }

    /**
     * `userText` matcher for canonical and hand-typed plugin mentions.
     * @returns {any} the rule object accepted by `uiConversation.userText.register`.
     */
    function pluginMentionRule() {
      return {
        id: 'plugin',
        order: 20,
        match(text, from) {
          if (typeof text !== 'string') return undefined;
          const canonical = /@\[([^\]\n]{1,200})\]\(dsh-plugin:([A-Za-z0-9@/._-]+)\)/gu;
          canonical.lastIndex = from;
          const first = canonical.exec(text);
          const shortcut = /@plugin:([A-Za-z0-9@/._-]+)/gu;
          shortcut.lastIndex = from;
          const second = shortcut.exec(text);
          if (first === null && second === null) return undefined;
          if (second === null || (first !== null && first.index <= second.index)) {
            return { id: 'plugin', start: first.index, end: first.index + first[0].length, data: { label: first[1], name: first[2] } };
          }
          return { id: 'plugin', start: second.index, end: second.index + second[0].length, data: { name: second[1] } };
        },
      };
    }

    /**
     * Register the mention source, the sent-message rule and its renderer.
     * @param {any} ctx - client context.
     */
    function registerPluginMentions(ctx) {
      const registered = [];
      const uiConversation = ctx.get('uiConversation');
      if (uiConversation !== undefined && uiConversation !== null
        && uiConversation.userText !== undefined && uiConversation.userText !== null
        && isFunction(uiConversation.userText.register)) {
        try {
          ctx.effect(() => uiConversation.userText.register(pluginMentionRule()), 'composer-draft-cache: @plugin text rule');
        } catch (error) {
          /* sent-message rendering is cosmetic; the mention still reaches the model */
        }
      }
      try {
        ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
          name: 'conversation.user.text.node',
          key: 'plugin',
          priority: 100,
        }, PluginMentionText));
      } catch (error) {
        /* renderer is cosmetic */
      }
      try {
        const inputTriggers = ctx.get('inputTriggers');
        if (inputTriggers !== undefined && inputTriggers !== null && isFunction(inputTriggers.registerSource)) {
          let primaryRegistered = false;
          for (const sourceName of SOURCE_NAMES) {
            const source = createPluginSource(ctx, sourceName, primaryRegistered === false);
            try {
              ctx.effect(() => inputTriggers.registerSource(source), `composer-draft-cache: @plugin source ${sourceName}`);
              registered.push(sourceName);
              if (primaryRegistered === false) primaryRegistered = true;
            } catch (error) {
              /* A previous plugin generation may still own this name (client HMR);
               * try the next name so the menu works without a page reload. */
            }
          }
        }
      } catch (error) {
        /* completion menu is optional; a typed @plugin:name still works */
      }
      return registered;
    }

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'composer-draft-cache: dictionaries');
      } catch (error) {
        /* locale is cosmetic */
      }
      registerPluginMentions(ctx);

      /**
       * Read one Session summary synchronously. Used only to decide whether a
       * cached new-session draft came from a Session that has already started.
       * @param {string} sessionId
       * @returns {Record<string, unknown> | undefined}
       */
      function readSessionSummary(sessionId) {
        try {
          const sessions = ctx.get('sessions');
          const list = sessions === undefined || sessions === null ? undefined : sessions.list;
          if (list === undefined || list === null || !isFunction(list.getSnapshot)) return undefined;
          const snapshot = list.getSnapshot();
          if (snapshot === undefined || snapshot === null) return undefined;
          const byId = snapshot.byId;
          if (byId === undefined || byId === null) return undefined;
          return byId[sessionId];
        } catch (error) {
          return undefined;
        }
      }

      /**
       * Headless dock entry: renders nothing, but observes the resident composer
       * through the slot's standard props. It saves the current draft while it is
       * unsent, and fills an empty composer from the matching cache entry.
       *
       * @param {Record<string, unknown>} props - slot standard props plus owner props.
       * @returns {null} always.
       */
      function DraftCacheBridge(props) {
        const sessionId = props.sessionId;
        const useSession = isFunction(props.useSession) ? props.useSession : absentSelector;
        const useSessions = isFunction(props.useSessions) ? props.useSessions : absentSelector;
        const useWorkspaces = isFunction(props.useWorkspaces) ? props.useWorkspaces : absentSelector;
        const useInput = isFunction(props.useInput) ? props.useInput : absentSelector;
        const inputActions = props.inputActions;

        const blank = useSession((snapshot) => {
          if (snapshot === undefined || snapshot === null) return undefined;
          return snapshot.blank === true;
        });
        const promptAttempted = useSession((snapshot) => {
          if (snapshot === undefined || snapshot === null) return undefined;
          return snapshot.promptAttempted === true;
        });
        const sessionCwd = useSessions((snapshot) => {
          if (snapshot === undefined || snapshot === null) return undefined;
          const byId = snapshot.byId;
          if (byId === undefined || byId === null) return undefined;
          const summary = byId[sessionId];
          return summary === undefined || summary === null ? undefined : summary.cwd;
        });
        const workspacePath = useWorkspaces((snapshot) => {
          if (snapshot === undefined || snapshot === null) return undefined;
          const items = snapshot.items;
          if (!Array.isArray(items)) return undefined;
          for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            if (item === undefined || item === null) continue;
            if (!Array.isArray(item.sessionIds) || item.sessionIds.indexOf(sessionId) === -1) continue;
            return typeof item.path === 'string' ? item.path : undefined;
          }
          return undefined;
        });
        /*
         * Read the composer through primitive selectors. The selector hooks are
         * bound with useSyncExternalStoreWithSelector (Object.is equality), so an
         * unrelated store publish (queue, occurrences, claim, uploads) neither
         * re-renders this headless entry nor re-runs its effect. The previous
         * whole-snapshot selector re-rendered and re-ran on every publish.
         */
        const draft = useInput((snapshot) => {
          if (snapshot === undefined || snapshot === null) return '';
          return typeof snapshot.draft === 'string' ? snapshot.draft : '';
        });
        const attachmentCount = useInput((snapshot) => {
          if (snapshot === undefined || snapshot === null) return 0;
          return Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds.length : 0;
        });
        const phase = useInput((snapshot) => {
          if (snapshot === undefined || snapshot === null) return undefined;
          return snapshot.phase;
        });

        const workspacePathKey = isNonEmptyString(workspacePath)
          ? workspacePath
          : (isNonEmptyString(sessionCwd) ? sessionCwd : undefined);

        /**
         * Per-mount lifecycle bookkeeping. `sawText` is what separates "fresh
         * composer" (safe to refill) from "composer emptied by send/clear"
         * (must never refill). It resets when this instance switches Sessions.
         */
        const tracker = React.useRef({ sessionId: undefined, sawText: false, wasBlank: undefined });

        React.useEffect(() => {
          if (sessionId === undefined || sessionId === null) return;
          if (blank === undefined) return;

          const track = tracker.current;
          if (track.sessionId !== sessionId) {
            track.sessionId = sessionId;
            track.sawText = false;
            track.wasBlank = blank;
          }
          const wasBlank = track.wasBlank;
          track.wasBlank = blank;

          const empty = draft === '' && attachmentCount === 0;
          const idle = phase === undefined || phase === 'plain' || phase === 'claimed';
          const canWrite = inputActions !== undefined && inputActions !== null && isFunction(inputActions.setDraft);
          if (draft !== '') track.sawText = true;

          const workspaceKey = workspacePathKey === undefined
            ? undefined
            : WORKSPACE_KEY_PREFIX + workspacePathKey;
          const sessionKey = SESSION_KEY_PREFIX + sessionId;

          if (blank === true) {
            /* New Session: the draft belongs to this Workspace's new-session box. */
            if (workspaceKey === undefined) return;
            if (empty && idle && track.sawText !== true) {
              const entry = decodeWorkspaceDraft(cacheGet(workspaceKey));
              if (entry !== undefined && isNonEmptyString(entry.text)) {
                const source = entry.session === undefined ? undefined : readSessionSummary(entry.session);
                if (source !== undefined && source !== null && source.blank === false) {
                  /* The blank Session that typed this draft has since started:
                   * its draft was submitted and must never come back. */
                  cacheDelete(workspaceKey);
                  return;
                }
                if (promptAttempted === true) {
                  if (entry.session === undefined || entry.session === sessionId) {
                    /* This reused blank Session attempted its first prompt, so the
                     * cached draft was submitted; drop it. */
                    cacheDelete(workspaceKey);
                  }
                  /* Otherwise the entry came from another still-blank Session: keep
                   * it for that Session instead of restoring it into this one. */
                  return;
                }
                if (canWrite) {
                  try {
                    inputActions.setDraft(entry.text);
                  } catch (error) {
                    /* keep the entry for a later blank Session */
                  }
                }
                return;
              }
            }
            if (draft === '') {
              cacheDelete(workspaceKey);
              return;
            }
            cacheSet(workspaceKey, encodeWorkspaceDraft(draft, sessionId));
            return;
          }

          /* Already-created ("historical") Session: keep its own unsent draft. */
          if (wasBlank === true && workspaceKey !== undefined) {
            /* This Session started from a new-session composer: the workspace
             * entry that fed it was consumed by that submission or abandonment. */
            cacheDelete(workspaceKey);
          }
          if (empty && idle && track.sawText !== true) {
            const cached = cacheGet(sessionKey);
            if (isNonEmptyString(cached)) {
              if (canWrite) {
                try {
                  inputActions.setDraft(cached);
                } catch (error) {
                  /* keep the entry for a later visit */
                }
              }
              return;
            }
          }
          if (draft === '') {
            cacheDelete(sessionKey);
            return;
          }
          cacheSet(sessionKey, draft);
        }, [sessionId, workspacePathKey, blank, promptAttempted, draft, attachmentCount, phase, inputActions]);

        return null;
      }

      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: DOCK_ENTRY_ID,
            order: 10,
          },
          DraftCacheBridge,
        ),
      );
    }

    exports.name = NAME;
    exports.inject = ['slots', 'inputTriggers', 'locale', 'remote', 'remote.pluginInventory', 'uiConversation'];
    exports.apply = apply;
    return module.exports;
  },
});
