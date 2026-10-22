# dsh-composer-draft-cache · 输入框草稿缓存

DeepSeek Harness（dsh）的 UI 增强插件：**记住尚未发出的输入框草稿**，切走再回来时自动填回；已发送或手动清空的草稿不会重新出现。缓存只在本次应用窗口生命周期内有效。

A DeepSeek Harness UI enhancement bundle. It keeps **unsent composer drafts**
and puts them back when you return to where you typed them, until the app
window closes:

- **New sessions** — a workspace's "new session" action opens a fresh blank
  Session each time, so text typed there is detached from the Session that
  showed it once you switch workspaces. The draft is cached **per workspace**
  and refilled into that workspace's next new-session composer.
- **Already-created ("historical") sessions** — an unsent draft is also cached
  **per Session id**, so it survives switching conversations, switching
  workspaces, and a page reload.

Sending or deliberately clearing a draft removes its cache entry immediately, so
submitted content never returns to the input box.

## Features

- **Headless**: registers one entry in the `conversation.input.dock` slot that
  always renders `null`; no visual footprint, no layout change.
- **Two scopes**: workspace key while the Session is still a new/blank Session,
  Session-id key once the Session has started.
- **Never resurrects sent text**: the restore predicate requires that this mount
  has not seen any text yet (`sawText`); once text was seen, an empty composer
  means send/clear and the entry is deleted instead of restored. Extra guards
  discard a new-session entry when its source Session already attempted a prompt
  (`promptAttempted`) or is no longer blank.
- **Performance**: composer state is read through primitive selectors
  (`draft` / attachment count / submit phase) with `Object.is` equality, so
  unrelated store publishes (queue, occurrences, claim, uploads) neither
  re-render the component nor re-run its effect. No timers, listeners, DOM
  writes, Host calls, or per-render allocations.
- **Storage**: in-memory map + `sessionStorage` mirror under
  `dsh.composer-draft-cache.v1:` (`workspace:<path>` / `session:<id>` keys).
  Survives a page reload, discarded when the app window closes; never writes to
  the Host or the Session log.

## Compatibility

Built and verified against DeepSeek Harness **0.2.1-rc.2** (Desktop profile). It
only uses the slot standard props supplied by
`@deepseek-ai/dsh-client-ui-conversation` (`conversation.input.dock`:
`sessionId`, `useSession`, `useSessions`, `useWorkspaces`, `useInput`,
`inputActions`); it does not import any Harness Client package.

## Install

1. Put this directory anywhere on disk (e.g. a workspace folder).
2. Install it as a profile bundle through the Plugin Manager, or with the
   `plugin_manager` tool:

   ```text
   plugin_manager action=install_bundle target=<absolute path to this directory>
   ```

3. Verify the live registration: the `composer-draft-cache` entry appears in
   the `conversation.input.dock` slot (Client Inspect → Slots).

## Usage

- Type into a workspace's "new session" composer, switch to another workspace,
  then open that workspace's "new session" again — the draft is back.
- Type into any already-created Session, switch away and return — that Session's
  draft is back.
- Send or delete the draft — it is gone and will not come back, even after
  switching away and returning.

## Limitations

- Drafts containing reference/command chips are restored as their plain
  clipboard text; attached images/files are not restored.
- The cache lives with the browser page: closing the app window clears it.
- The `sessionStorage` mirror keys are plugin-owned; drafts are never written to
  the Session log.

## Development

```bash
node --check client.js
node --test test/logic.test.mjs
```

`test/logic.test.mjs` loads the real `client.js` in a `vm` sandbox with a
stub React hook dispatcher and stub Slot/session services, then drives the
cache/restore state machine (14 scenarios, including send/clear bounce-back
guards and a hot-path perf regression).

## License

MIT — see [LICENSE](LICENSE).

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
