# Paper Trails for Mac

A thin native shell (AppKit + WKWebView, one Swift file) around the web
workbench. With the optional sync account (⇅ in the app's top bar) the
workspace follows you between this app and any browser — the Mac app is
effectively another synced device.

- Persistent website data store: streams, API keys, and the signed-in session
  survive relaunch
- Links that leave the app's origin (external literature tools, papers) open
  in your default browser
- Blob downloads — Export data (JSON), BibTeX / RIS / CSV — land in
  `~/Downloads`
- `⌘R` reload, `⌘W` close, `⌘Q` quit, standard Edit-menu clipboard keys

## Build

```sh
macos/build.sh            # → macos/build/Paper Trails.app
open "macos/build/Paper Trails.app"
```

Requires the Xcode command-line tools (`swiftc`, `sips`, `iconutil`,
`codesign`). The app icon is the misclaw logo (`icon.png`) at build time.

Development against a local dev server:

```sh
PT_URL=http://localhost:5173 "macos/build/Paper Trails.app/Contents/MacOS/PaperTrails"
```

## Distribution notes

The build is **ad-hoc signed** — fine for your own machine. Distributing to
others needs a Developer ID certificate + notarization
(`codesign --sign "Developer ID Application: …"`, `notarytool submit`);
without it, downloaders must right-click → Open to bypass Gatekeeper.
