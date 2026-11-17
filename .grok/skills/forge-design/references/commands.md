# Command reference

Run all commands through `scripts/bridge.sh`.

```text
health
status
tabs
url
title
goto <url>
newtab [url]
activate <tabId>
reload
text
snapshot [limit]
click <selector>
focus <selector>
fill <selector> <text...>
type <text...>
press <key>
wait <selector>
exists <selector>
scroll [y]
eval <js...> | eval --file <script.js>
screenshot [--full] [--selector <css|ref>] [--out <file>] [--jpeg] [--foreground]
upload <selector> <file...>
frames
console [--errors] [--clear] [--limit n]
network [--failed] [--clear] [--limit n]
reload-extension
last-pick
start-pick
last-place
start-place
raw <json>
```

Every command also takes `--tab <id>` and `--frame <id>`.

## Refs

`snapshot` gives each interactive element a `ref` with role, name, value and state. Use the ref wherever a selector goes, until the next snapshot:

```sh
scripts/bridge.sh snapshot 40
scripts/bridge.sh fill e3 'hello'
scripts/bridge.sh click e7
```

If the page has iframes, the top-frame `snapshot` lists them under `frames`. Snapshot one with `--frame <id>`; its refs look like `f1242e3` and route to that frame on their own. `text` already includes each frame's text.

## Screenshots

The image goes to a file; the command prints its `path`. Chrome does not paint background tabs, so the agent tab needs `--foreground` (brings it to the front). A tab the user is looking at can be captured with `--tab <id>` without stealing anything. `--full` scrolls and stitches up to 8 screens, hiding fixed/sticky bars after the first; pages that scroll an inner container only give one screen.

## Console and network

`console` and `network` read a monitor that starts when the agent tab loads a page. On other tabs the first call starts it; run `reload` to capture page load. `network` also lists resource timings since load. `--clear` empties the buffer after reading.

## Raw examples

Scroll an element into view:

```sh
scripts/bridge.sh raw '{"command":"scroll","args":{"selector":"button[data-testid=save]","block":"center"}}'
```

Wait for a URL change:

```sh
scripts/bridge.sh raw '{"command":"wait","args":{"urlIncludes":"/success","timeoutMs":15000}}'
```

Read the element the user last pointed at in the extension picker:

```sh
scripts/bridge.sh last-pick
```

Wait for the user to pick an element on the current page (up to 90s):

```sh
scripts/bridge.sh start-pick
```

Read the last Forge block(s) the user confirmed onto the page (after 写入源码). `places` is the full numbered list; `place` is the first item for compatibility; `layout` is the spatial map (`relativeToIndex`, `position`, preview `rect`):

```sh
scripts/bridge.sh last-place
```

Use the active user tab only when the user asked you to take over their current tab. `useActive`, `focus`, and `foreground` steal keyboard or window focus — default commands already run on the silent agent tab.

```sh
scripts/bridge.sh raw '{"command":"snapshot","args":{"useActive":true,"limit":80}}'
```

`eval` runs any JavaScript in the page's main world (top-level `await` works; page CSP does not block it) and returns the last value. Prefer `click` / `fill` for interaction so the user sees the cursor.
