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

    function apply(ctx) {
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
            order: 8,
          },
          DraftCacheBridge,
        ),
      );
    }

    exports.name = NAME;
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
