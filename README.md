# Pi Browser Capture

Add a selected area from the browser directly to the **Pi terminal input**: the screenshot, a DOM summary within the selected area, page information, and any additional prompt are added to the draft. When submitted, the screenshot is sent as an actual image.

Supports Chrome / Edge and Firefox. Multiple Pi or omp processes can be online on the same machine, and the browser can choose which session receives each capture. No standalone bridge service is required.

## Installation

### Pi extension

```bash
npm ci
npm run check
pi install .
```

The extension loads automatically when Pi starts. In an existing Pi window, run `/reload`.

### Browser extension

| Browser | Loading method |
| --- | --- |
| Chromium | `chrome://extensions` → enable Developer mode → drag `dist/browser/chromium.zip` into the page |
| Firefox | `about:addons` → drag `dist/browser/firefox/pi-browser-capture.zip` into the page |

### Pairing

1. Start Pi and run `/browser-capture pair`.
2. Open the browser extension, paste the token shown by Pi into Connection Settings, and click Pair and Connect.
3. After “Session online” appears, the extension is ready to use. All processes sharing the same Pi user profile directory use the same token, so pairing is usually required only once.

The extension listens on an available port in `127.0.0.1:43821–43852`, and the browser connects to it. No service needs to be started manually; the connection recovers automatically after either side exits, reloads, or disconnects. If the selected session changes or disappears, you must select a session again. Captures are never forwarded automatically to another session.

When Pi runs in WSL and the browser runs on Windows, pair using the `Mirror` network as described above.

## Usage

### Slash commands

| Slash command | Behavior |
| --- | --- |
| `/browser-capture pair` | Display the pairing token |
| `/browser-capture status` | Show the listening port, current session, and attachment directory |
| `/browser-capture list` | List attachments saved for the current session and their paths |
| `/browser-capture delete <UUID>` | Delete the specified attachment for the current session and remove its corresponding marker from the draft |

### Browser extension

1. Click the extension icon on a webpage and choose Rectangle Selection or Element Selection. You can also press `Alt+Shift+P` to start a rectangle selection directly, or `Esc` to cancel.
2. In the extension preview window, inspect the screenshot and DOM, enter an additional prompt, and choose a Pi session.
3. By default, submission includes only a visible-text DOM summary capped at 2,000 characters. Enable Send full DOM to include the collected HTML and full visible text instead. This option starts unchecked for each capture; full DOM still follows the collection limits (1,500 nodes / 60,000 HTML characters).
4. Click Add to Pi Draft, then return to the terminal to continue editing and submit.

Existing input is not overwritten. Multiple selections can be appended to the same draft. The Pi editor displays the attachment count above the input, and the draft contains `[pi-browser-capture:…]` markers. Deleting a marker cancels submission of the corresponding image and DOM context. The accompanying plain text remains available for editing or deletion.

In summary mode, the browser sends only the bounded DOM summary together with the screenshot and page/selection metadata (including the locator for element selections). Pi saves only that summary, without a `dom.html` file or full text in `capture.json`. Only Send full DOM transmits and saves the collected HTML and full text. Captures received without this option also use summary mode.

The Pi terminal displays a summary. When the user submits, images are merged through Pi's `input` event. Existing images and Pi-native `steer` / `followUp` input remain compatible.

If Include current site login state is enabled, the browser requests cookies and current-site permissions as needed, then adds:

- Cookies for the current page URL, including accessible HttpOnly cookies, from the same cookie store as the source tab.
- `localStorage` and `sessionStorage` for the top-level page's current origin.
- Partitioned cookies when supported by the browser. If they cannot be retrieved, the summary explains why. In Firefox first-party isolation mode, if additional context is required, storage is retained and the summary explains that cookies are unavailable; cookies are never queried across isolation domains. [Cookie isolation rules](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/getAll)

### Attachment directory

The default attachment directory is `~/.pi/agent/browser-capture/`. Set `PI_CODING_AGENT_DIR` to change it. Each session and capture uses a separate directory:

```text
browser-capture/
  pairing-token
  attachments/<session-id>/<capture-id>/
    screenshot.png
    dom.html              # Generated only when Send full DOM is enabled
    dom.txt               # Summary by default; full text only when enabled
    page.json
    capture.json
    login-state.json       # Generated only when enabled
```

## License
[MIT](LICENSE)
