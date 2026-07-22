# CardMirror plugin API v1

The published contract for CardMirror plugins and for flowing apps.
This document freezes the v1 surface. The sources of truth are
`src/editor/plugin-api.ts`, `src/editor/plugin-registry.ts`,
`apps/desktop/src/plugin-manager.ts`,
`apps/desktop/src/bridge-handshake.ts`, and
`apps/desktop/src/fast-paste-bridge.ts`.

Audience: plugin authors and authors of flowing apps. Sections 1 to 3
and 6 cover renderer plugins. Sections 4 and 5 cover cross-app
integration over HTTP.

## 1. Plugin packaging

A plugin is one GitHub repository. Each release attaches two assets:

- `cardmirror-plugin.json` - the manifest.
- `plugin.js` - the built bundle. Only the released bundle loads. The
  repo source format does not matter.

### Manifest fields

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `id` | string | yes | Lowercase. Must match `^[a-z0-9][a-z0-9-]*$`. |
| `name` | string | yes | Display name. |
| `version` | string | yes | Semver, for example `0.1.0` or `0.2.0-beta.1`. |
| `description` | string | no | One line for the Plugins tab. |
| `author` | string | no | Shown in the consent prompt. |
| `apiVersion` | number | yes | Must be `1`. |
| `minAppVersion` | string | no | Oldest CardMirror version that the plugin supports. |
| `repo` | string | never in your release | The installer stamps `owner/repo` into the saved manifest. Update checks read it. Do not set it yourself. |

Example:

```json
{
  "id": "cardmirror-ebb",
  "name": "ebb Flow Integration",
  "version": "0.1.0",
  "description": "Send to flow, send extension, and inverse search for ebb.",
  "author": "smodi",
  "apiVersion": 1,
  "minAppVersion": "0.1.0-beta.18"
}
```

### Install flow

1. The user pastes a GitHub URL or an `owner/repo` shorthand into the
   Plugins settings tab.
2. The main process fetches the latest GitHub release and downloads
   the two assets.
3. The app validates the manifest and applies the version gates below.
4. The app writes both files into `userData/plugins/<id>/` with an
   atomic write (tmp file, then rename).
5. The user enables the plugin in the Plugins tab. Enabled plugins
   load from disk at each launch and work offline.

A developer path exists: "Load plugin from file..." in the Plugins tab
loads a local `plugin.js` without an install.

### Version gates

- `apiVersion` must equal `1`. Install rejects any other value.
  Registration rejects it again at load time (section 2).
- If `minAppVersion` is newer than the app version, install fails with
  "This plugin needs CardMirror `<minAppVersion>` or newer."
- The gate is two-sided. At run time, read `api.appVersion` and refuse
  an app that is too old for your plugin.

## 2. Registration

The bundle self-registers. Call the window global once at load:

```js
window.__registerCardMirrorPlugin?.({ /* PluginDefinition */ });
```

The definition types, verbatim from `src/editor/plugin-registry.ts`:

```ts
export const PLUGIN_API_VERSION = 1;

export interface PluginCommandDef {
  /** Must start with `<pluginId>.` */
  id: string;
  label: string;
  keywords?: readonly string[];
  defaultKey?: string | string[] | null;
  run: (api: CardMirrorPluginApi) => void | Promise<void>;
}

export interface PluginDefinition {
  id: string;
  name: string;
  apiVersion: number;
  commands: PluginCommandDef[];
}
```

Rules:

- `id` must match the manifest `id`.
- Every command `id` must start with `<pluginId>.`, for example
  `cardmirror-ebb.sendToFlow`.
- Command ids must be unique, both inside the definition and across
  all registered plugins.
- Every command needs a non-empty `label` and a `run` function.
- Each registered plugin receives one `CardMirrorPluginApi` object,
  minted for its plugin id. Registered commands appear in the command
  palette and the keymap.

### Failure behavior

Registration never throws and never crashes the app. The registry
rejects a bad definition, writes a console warning, and shows the
toast "Plugin failed to load: `<reason>`". Rejection reasons:

- `apiVersion` is not `1`.
- The plugin id is missing, or a plugin with that id is already
  registered.
- `commands` is not an array.
- A command id lacks the `<pluginId>.` prefix, or is a duplicate.
- A command lacks a `label` or a `run` function.

A `run` function that throws, or that returns a rejected promise, does
not crash the app. The registry logs the error and shows a toast with
the plugin name.

## 3. The capability API

Each command's `run` receives one `api` argument. The full surface,
verbatim from `src/editor/plugin-api.ts`:

```ts
export type ExtractedKind =
  | 'pocket'
  | 'hat'
  | 'block'
  | 'tag'
  | 'analytic'
  | 'undertag'
  | 'cite';

export interface ExtractedItem {
  kind: ExtractedKind;
  text: string;
  /** Opaque provenance token (see plugin-source-token.ts). */
  source: string;
}

export interface ExtractResult {
  ok: true;
  docId: string;
  docTitle: string;
  items: ExtractedItem[];
}

export type ExtractErrorCode = 'no-heading-at-cursor' | 'no-active-doc' | 'empty-selection';
export interface ExtractError {
  ok: false;
  error: ExtractErrorCode;
}

export type JumpResult =
  | { ok: true }
  | { ok: false; error: 'doc-not-open' | 'not-found' | 'bad-request'; docTitle?: string };

export interface FlowAppInfo {
  id: string;
  app: string;
  appVersion: string;
  schema: number;
  kind: 'flow';
}

export type FlowPostResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: 'no-such-app' | 'app-not-running' | 'timeout' | 'bad-response' | 'unsupported' };

export interface PluginStorage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface CardMirrorPluginApi {
  readonly appVersion: string;
  extractSelection(): ExtractResult | ExtractError;
  jumpToSource(token: string): Promise<JumpResult>;
  flowApps(): Promise<FlowAppInfo[]>;
  flowPost(appId: string, route: string, body: unknown): Promise<FlowPostResult>;
  docInfo(): { docId: string; docTitle: string } | null;
  showToast(message: string): void;
  storage: PluginStorage;
}
```

### Methods

- `appVersion` - the CardMirror version string. Use it for your own
  compatibility check.
- `extractSelection()` - synchronous typed extraction from the focused
  document (rules below). If the document has no `docId` yet, the call
  mints and stamps one.
- `jumpToSource(token)` - scroll to and select the source of an
  extracted item. The resolver tries the focused document first, then
  every open window. `doc-not-open` carries `docTitle` so you can tell
  the user which document to open.
- `flowApps()` - live flowing apps from the handshake directory
  (section 4). Stale entries fail the liveness ping and do not appear.
- `flowPost(appId, route, body)` - a brokered loopback POST to a
  flowing app. The main process reads the target's handshake file,
  attaches the token header, and applies a timeout. Plugins never see
  tokens or sockets. `unsupported` means the desktop host surface is
  absent.
- `docInfo()` - `docId` and `docTitle` of the focused document, or
  `null` when there is none or the doc has no id yet.
- `showToast(message)` - a transient notification in the app.
- `storage` - per-plugin persistent key-value storage. Values must be
  JSON-serializable.

### Extraction rules

The selection rule:

- An explicit selection wins. Extraction walks only the selected range.
- A collapsed cursor expands to the enclosing heading section: from
  the nearest enclosing heading to the next heading of the same or a
  shallower level.
- A cursor above all headings returns `no-heading-at-cursor`. Core
  does not guess.
- A range that yields no items returns `empty-selection`.
- No focused document returns `no-active-doc`.

The item rules, in document order:

- Pocket, hat, block, tag, and analytic nodes emit their full text.
- Cite paragraphs emit the short cite only, with kind `cite`.
- Undertags always emit, with kind `undertag`. The plugin decides what
  to do with them: skip, treat as header, or treat as extension.
- Card bodies and loose paragraphs never emit. This rule is deliberate
  and has no override.
- Whitespace in each item collapses to single spaces. Empty items are
  dropped.

Heading attribution per item: pocket, hat, block, tag, and analytic
items carry their own heading UUID. An undertag or cite inside a card
carries the UUID of the parent card's tag or analytic. A top-level
undertag carries the UUID of the nearest preceding heading.

### The source token

Each extracted item carries one provenance string in `source`. The
current format starts with the `cmsrc1` prefix. The token is opaque:

- Store it.
- Pass it back verbatim, to `jumpToSource` or to the `/jump` route.
- Never parse it and never build one. Only CardMirror mints and parses
  tokens. A future format change bumps the prefix, and old tokens stay
  valid.

## 4. The cardmirror-bridge handshake

This section and section 5 are the frozen cross-app contract. Flowing
apps build against this file format and these routes. Changes require
a schema bump.

Each debate app announces its local HTTP endpoint in a shared
directory. The directory per platform:

- macOS: `~/Library/Application Support/cardmirror-bridge/`
- Windows: `%APPDATA%/cardmirror-bridge/`
- Linux: `$XDG_DATA_HOME/cardmirror-bridge/` (fallback
  `~/.local/share/cardmirror-bridge/`)

Each app writes `<appId>.json` on launch and deletes it on quit. The
write must be atomic: write a tmp file, then rename it into place.
CardMirror writes `cardmirror.json` with `kind: "editor"`. Flowing
apps register with `kind: "flow"`. The file name (without `.json`) is
the app id and must match `^[a-z0-9][a-z0-9-]*$`.

File format, schema 1:

```json
{
  "schema": 1,
  "app": "ebb",
  "appVersion": "0.3.0",
  "kind": "flow",
  "port": 17700,
  "token": "hoyfR3k9vXqLmZ2wN8cT1bUj",
  "pid": 12345
}
```

Rules:

- The token is random and rotates each session. A port scan finds
  nothing usable without the current file.
- Every request between apps carries the target's token in the
  `X-Bridge-Token` header. The receiver must compare it in constant
  time.
- Liveness: a reader sends `GET /ping` with the token before it trusts
  a file. A stale file from a crashed process fails the ping, and the
  reader skips it.
- Bind the endpoint to `127.0.0.1` only. Never bind `0.0.0.0`.

## 5. CardMirror's HTTP routes for flowing apps

CardMirror serves these routes on the port in `cardmirror.json`. All
routes require the token, in `X-Bridge-Token` or in the legacy
`X-FDP-Token` header. A request with an `Origin` or `Referer` header
is rejected with 403; those requests come from browser pages.

### GET /ping

Liveness and capability probe. Response, schema 2:

```json
{
  "ok": true,
  "app": "cardmirror",
  "appVersion": "0.1.0-beta.18",
  "schema": 2,
  "hasActiveDoc": true
}
```

`schema: 2` signals that `/jump` is available.

### POST /insert

Insert text into the focused document. This route predates the plugin
API and is unchanged. The full wire contract is in
`cardmirror-integration-spec.md` in this folder. In short: the body is
`{ "text": "...", "role": "card" | "cite" | "inline", "newParagraph": true, "omitted": false }`,
and the response is `{ "ok": true, "inserted": true, "docTitle": "..." }`
or `{ "ok": false, "error": "no-target-doc" | "doc-readonly" | "bad-request" }`.

### POST /jump

Inverse search: jump to the source of an extracted item. Send the
stored source token, verbatim:

```json
{ "source": "cmsrc1.eyJkb2NJZCI6..." }
```

On success, CardMirror focuses the right window, scrolls to the
source, and selects it:

```json
{ "ok": true }
```

Error responses:

| Error | HTTP status | Meaning | Extra field |
| --- | --- | --- | --- |
| `doc-not-open` | 200 | The token's document is not open in any window. | `docTitle` - show "open `<docTitle>` first". |
| `not-found` | 200 | The document is open, but the heading and the text anchor both failed to resolve. | none |
| `bad-request` | 400 | The body is not JSON, `source` is missing, or the token does not parse. | none |

Example `doc-not-open` response:

```json
{ "ok": false, "error": "doc-not-open", "docTitle": "AT - Cap K" }
```

Any other path returns 404 with `{ "ok": false, "error": "bad-request" }`.

## 6. A minimal example plugin

`plugin.js` - registers one command. The command extracts the
selection and toasts the item count:

```js
// plugin.js - complete example bundle
window.__registerCardMirrorPlugin?.({
  id: 'item-counter',
  name: 'Item Counter',
  apiVersion: 1,
  commands: [
    {
      id: 'item-counter.countSelection',
      label: 'Count extracted items',
      keywords: ['count', 'extract'],
      defaultKey: null,
      run(api) {
        const result = api.extractSelection();
        if (!result.ok) {
          api.showToast('Extraction failed: ' + result.error);
          return;
        }
        const n = result.items.length;
        api.showToast(
          'Extracted ' + n + (n === 1 ? ' item from "' : ' items from "') +
            result.docTitle + '"',
        );
      },
    },
  ],
});
```

`cardmirror-plugin.json`:

```json
{
  "id": "item-counter",
  "name": "Item Counter",
  "version": "0.1.0",
  "description": "Count the items that selection extraction returns.",
  "author": "you",
  "apiVersion": 1,
  "minAppVersion": "0.1.0-beta.18"
}
```

To test it, open Settings, then Plugins, then "Load plugin from
file...", and pick `plugin.js`. Run "Count extracted items" from the
command palette.
