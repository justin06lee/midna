import AppKit
import WebKit

// Pictures of a page drawn by WebKit, the engine the Mac app uses, without a window on screen: it works while
// the Mac is locked or the display is asleep, when the built app itself paints nothing. Use it on the production
// page (`bun run build`, then `bunx vite preview --port 5192`) against the throwaway midna (`bun run preview`):
//
//   swiftc -O scripts/websnap.swift -o /tmp/websnap
//   /tmp/websnap "http://localhost:5192/?light=1&connect=<from bun run preview>" <out dir> 1040 700 \
//     "chat=1" "menu-open=document.querySelector('button[aria-haspopup=menu]').click(); 1" "menu=1"
//
// Each step runs its JavaScript, waits a moment and saves <name>.png at the screen's scale. What it can't show:
// the title bar and anything the app does through Tauri (This Computer, the panels over the screen), and :hover.
let args = CommandLine.arguments
let url = URL(string: args[1])!
let out = args[2]
let size = NSSize(width: Double(args[3])!, height: Double(args[4])!)
let steps = args.dropFirst(5).map { s -> (String, String) in
  let i = s.firstIndex(of: "=")!
  return (String(s[s.startIndex..<i]), String(s[s.index(after: i)...]))
}

final class Shooter: NSObject, WKNavigationDelegate {
  let web: WKWebView
  let window: NSWindow
  var left: [(String, String)]
  init(steps: [(String, String)]) {
    left = steps
    let config = WKWebViewConfiguration()
    // A page that isn't on screen doesn't run its transitions, so a picture would catch a colour or an opacity
    // at its starting value: every change lands at once here, which is where it would have ended anyway.
    let settle = "const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; }'; document.documentElement.appendChild(s);"
    config.userContentController.addUserScript(WKUserScript(source: settle, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
    // A window that is never put on screen: the view needs one to lay out at the screen's scale.
    window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -4000, y: -4000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = web
    super.init()
    web.navigationDelegate = self
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { self.next() }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { print("failed: \(error.localizedDescription)"); exit(1) }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { print("failed to load: \(error.localizedDescription)"); exit(1) }
  func next() {
    guard !left.isEmpty else { print("done"); exit(0) }
    let (name, js) = left.removeFirst()
    web.evaluateJavaScript(js) { result, error in
      if let error = error { print("[\(name)] js: \(error.localizedDescription)") } else if let r = result { print("[\(name)] \(r)") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = true
        self.web.takeSnapshot(with: config) { image, error in
          guard let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
            print("[\(name)] no picture: \(error?.localizedDescription ?? "?")")
            return self.next()
          }
          try? png.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
          print("[\(name)] saved \(rep.pixelsWide)x\(rep.pixelsHigh)")
          self.next()
        }
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let shooter = Shooter(steps: steps)
shooter.web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { print("gave up"); exit(2) }
app.run()
