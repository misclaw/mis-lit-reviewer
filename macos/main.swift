// Paper Trails for Mac — a thin, persistent WKWebView shell around the web
// workbench. With account sync (⇅ in the app's top bar) the workspace follows
// the user between this app and any browser.
//
//   • Loads https://mis-lit-reviewer.misclaw.app (override: PT_URL env var,
//     e.g. PT_URL=http://localhost:5174 for development)
//   • localStorage / IndexedDB / auth tokens persist in the default website
//     data store, so streams, keys, and the signed-in session survive relaunch
//   • Links that leave the app's origin open in the default browser
//   • Blob downloads (Export JSON / BibTeX / RIS / CSV) land in ~/Downloads
import Cocoa
import WebKit

let APP_URL = ProcessInfo.processInfo.environment["PT_URL"] ?? "https://mis-lit-reviewer.misclaw.app/"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var appHost: String!

  func applicationDidFinishLaunching(_ note: Notification) {
    let url = URL(string: APP_URL)!
    appHost = url.host

    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default() // persistent: the workspace survives relaunch
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.allowsMagnification = true

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Paper Trails"
    window.minSize = NSSize(width: 720, height: 480)
    window.setFrameAutosaveName("PaperTrailsMain")
    window.contentView = webView
    window.center()
    window.makeKeyAndOrderFront(nil)

    webView.load(URLRequest(url: url))
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  // ---- navigation: keep the app on its origin, push the rest to the browser ----
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { decisionHandler(.download); return }
    guard let url = action.request.url else { decisionHandler(.allow); return }
    let external = (url.scheme == "http" || url.scheme == "https")
      && url.host != appHost && url.host != "localhost" && url.host != "127.0.0.1"
    if external && action.navigationType == .linkActivated {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
    } else {
      decisionHandler(.allow)
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }

  // window.open / target=_blank (external literature tools) → default browser
  func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    print("loaded: \(webView.url?.absoluteString ?? "?")")
    fflush(stdout)
  }

  // JS confirm()/alert() (import replace, tour offer) need native panels
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage msg: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = "Paper Trails"; a.informativeText = msg
    a.runModal(); completionHandler()
  }
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = "Paper Trails"; a.informativeText = msg
    a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  // ---- downloads (blob: exports) → ~/Downloads, deduped name ----
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    var dest = dir.appendingPathComponent(suggestedFilename)
    let base = dest.deletingPathExtension().lastPathComponent
    let ext = dest.pathExtension
    var n = 1
    while FileManager.default.fileExists(atPath: dest.path) {
      dest = dir.appendingPathComponent("\(base) (\(n))" + (ext.isEmpty ? "" : ".\(ext)"))
      n += 1
    }
    completionHandler(dest)
  }
  func downloadDidFinish(_ download: WKDownload) {
    print("download finished"); fflush(stdout)
  }
}

// ---- minimal main menu: quit, close, and full Edit bindings (copy/paste) ----
func buildMenu() -> NSMenu {
  let main = NSMenu()

  let appItem = NSMenuItem(); main.addItem(appItem)
  let appMenu = NSMenu()
  appMenu.addItem(withTitle: "About Paper Trails",
    action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
  appMenu.addItem(.separator())
  appMenu.addItem(withTitle: "Hide Paper Trails", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
  appMenu.addItem(withTitle: "Quit Paper Trails", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
  appItem.submenu = appMenu

  let fileItem = NSMenuItem(); main.addItem(fileItem)
  let fileMenu = NSMenu(title: "File")
  fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
  fileItem.submenu = fileMenu

  let editItem = NSMenuItem(); main.addItem(editItem)
  let editMenu = NSMenu(title: "Edit")
  editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
  editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
  editMenu.addItem(.separator())
  editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
  editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
  editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
  editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
  editItem.submenu = editMenu

  let viewItem = NSMenuItem(); main.addItem(viewItem)
  let viewMenu = NSMenu(title: "View")
  viewMenu.addItem(withTitle: "Reload", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
  viewItem.submenu = viewMenu

  return main
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.mainMenu = buildMenu()
let delegate = AppDelegate()
app.delegate = delegate
app.run()
