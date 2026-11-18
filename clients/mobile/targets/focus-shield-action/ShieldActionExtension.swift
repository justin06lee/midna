import ManagedSettings
import UserNotifications

/**
 * A shield's buttons. A shield can't open another app, so each leaves a
 * notification that does when tapped: the offer's link (Justice, a study
 * block), or midna's chat to ask for a lift with a reason. The app reads
 * `midnaFocus` in the notification's data (clients/mobile/src/focus.ts).
 */
class ShieldActionExtension: ShieldActionDelegate {
  override func handle(action: ShieldAction, for application: ApplicationToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
    completionHandler(respond(to: action))
  }

  override func handle(action: ShieldAction, for webDomain: WebDomainToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
    completionHandler(respond(to: action))
  }

  override func handle(action: ShieldAction, for category: ActivityCategoryToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
    completionHandler(respond(to: action))
  }

  private func respond(to action: ShieldAction) -> ShieldActionResponse {
    switch action {
    case .primaryButtonPressed:
      if let offer = Focus.offer {
        notify(title: offer.title, body: "Tap to open it.", data: ["midnaFocus": "offer", "url": offer.url ?? ""])
      }
      return .close
    case .secondaryButtonPressed:
      notify(title: "midna", body: "Tap to say why you need it, and for how long.", data: ["midnaFocus": "ask"])
      return .close
    // Later iOS has more (a submenu's items); this shield offers none of them.
    default:
      return .close
    }
  }

  private func notify(title: String, body: String, data: [String: String]) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.userInfo = data
    content.interruptionLevel = .timeSensitive
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "midna-focus", content: content, trigger: nil))
  }
}
