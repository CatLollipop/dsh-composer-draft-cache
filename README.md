# dsh-composer-draft-cache · 输入框增强（草稿缓存 + @插件）

DeepSeek Harness（dsh）的输入框增强插件，包含两个能力：

1. **草稿缓存**：记住尚未发出的输入框草稿，切走再回来时自动填回；已发送或手动清空的草稿不会重新出现。
2. **`@` 插件提及**：在输入框里输入 `@` 即可选择已安装的社区插件（而不是只能 @ 文件/会话）；选中后会插入一个原子引用，Agent 本轮会被明确告知"用户指定使用该插件"，并收到该插件的名称与说明。例如：`@ui-ux 设计插件的标题 帮我做这个页面的 UI/UE 设计`。

A DeepSeek Harness composer-enhancement bundle with two features:

- **Draft cache** — keeps unsent composer drafts and puts them back when you
  return: per workspace for "new session" composers (each workspace's *new
  session* action opens a fresh blank Session), and per Session id for
  already-created ("historical") Sessions. Sending or deliberately clearing a
  draft removes its entry immediately, so submitted content never returns.
- **`@plugin` mentions** — typing `@` in the composer now offers one more
  completion group: the installed community plugins, next to files and
  Sessions. Picking one inserts an atomic mention chip; the Host half reads the
  mention from the accepted user message and publishes the selected plugin's
  metadata as bounded runtime context, so the model knows the user explicitly
  chose that plugin for this turn.

## Features

### Draft cache

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
  re-render the component nor re-run its effect. No timers, DOM writes, or
  per-render allocations.
- **Storage**: in-memory map + `sessionStorage` mirror under
  `dsh.composer-draft-cache.v1:` (`workspace:<path>` / `session:<id>` keys).
  Survives a page reload, discarded when the app window closes; never writes to
  the Host or the Session log.

### `@plugin` mentions

- **Composer menu**: a second `@` source (`plugin`) lists enabled community
  plugins from the Host `pluginInventory` Remote, newest snapshot cached for a
  few seconds; the live query filters by title, module name and description.
  Core `@deepseek-ai/*` platform rows are not listed — only plugins you
  installed on top of the harness.
- **Atomic mention chip**: a pick inserts `@[Title](dsh-plugin:<package name>)`
  as an atomic reference (source `plugin`), displayed as `@ Title`; the
  hand-typed shortcut `@plugin:<package name>` works too.
- **Model effect**: on `agent/pre-step` the Host half collects mentions from the
  accepted user messages, keeps them for the turn (later tool-call steps keep
  the same selection), and publishes a bounded `## User-selected plugins`
  block through `ctx.systemPrompt.context()`: display title, package name,
  Loader entry id and description, plus the instruction that the user asked to
  use that plugin and that non-existent capabilities must not be invented.
  Unknown/disabled packages are reported instead of guessed.
- **Sent-message rendering**: a `userText` rule and a
  `conversation.user.text.node` renderer show the mention as a compact inline
  chip in Chat instead of raw Markdown.

## Compatibility

Built and verified against DeepSeek Harness **0.2.1-rc.2** (Desktop profile).
Uses documented extension seams only:

- Client: `slots`, `inputTriggers.registerSource`, `uiConversation.userText`,
  `remote.pluginInventory`, `locale`.
- Host: `loader`, `systemPrompt.context`, the `agent/pre-step` waterfall
  (returns the downstream decision unchanged and only records the selection).

It does not import Harness Client packages; UI styling uses `--dsw-alias-*`
theme tokens only.

## Install

1. Put this directory anywhere on disk (e.g. a workspace folder).
2. Install it as a profile bundle through the Plugin Manager, or with the
   `plugin_manager` tool:

   ```text
   plugin_manager action=install_bundle target=<absolute path to this directory>
   ```

3. Refresh the Web GUI once. Verify the live registration: the
   `composer-draft-cache` entry appears in `conversation.input.dock`, and the
   `plugin` entry in `conversation.user.text.node`.

## Usage

- Type into a workspace's "new session" composer, switch to another workspace,
  then open that workspace's "new session" again — the draft is back.
- Type into any Session, switch away and return — that Session's draft is back.
- Send or delete the draft — it is gone and will not come back.
- Type `@` in the composer: files and Sessions appear as before, and a
  **Plugins** group lists installed community plugins. Pick one (for example a
  UI/UE design plugin), then describe the task; the agent receives the plugin's
  metadata as explicit runtime context for that turn.
- You can also hand-type `@plugin:<package name>`.

## Limitations

- Drafts containing reference/command chips are restored as their plain
  clipboard text; attached images/files are not restored.
- The draft cache lives with the browser page: closing the app window clears it.
- `@plugin` completion lists Loader-visible plugins (a community plugin needs at
  least one Host row, which every `dsh.bundle` patch normally inserts). A
  client-only package without a Host row is not listed; hand-typing its exact
  package name still reaches the model as a mention but without injected
  metadata.
- The mention selection applies while its turn runs; a later turn without any
  mention clears it.
- The `@` source registers under `plugin`; on a page that went through several
  hot reloads of this plugin it may fall back to `plugins` / `plugin-mentions`
  (and the two extra names exist as serializer aliases). A normal page reload
  restores the preferred name.

## Development

```bash
node --check client.js index.js lib/mentions.js
node --test test/logic.test.mjs test/mentions.test.mjs
```

- `test/logic.test.mjs` loads the real `client.js` in a `vm` sandbox with a stub
  React hook dispatcher and stub Slot/session/locale/inventory services: draft
  cache scenarios, restore/send/clear guards, and the `@plugin` completion
  source, pick serialization and sent-message rule.
- `test/mentions.test.mjs` covers the pure mention parsing/rendering helpers and
  drives `index.js` against a stub Cordis context the way the agent loop does
  (runtime-context provider + `agent/pre-step` waterfall).

## License

MIT — see [LICENSE](LICENSE).

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
