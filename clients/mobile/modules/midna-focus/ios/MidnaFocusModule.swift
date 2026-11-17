import ExpoModulesCore
import FamilyControls
import SwiftUI

/**
 * Screen Time for midna, on Justin's own phone (FamilyControls with
 * individual authorization): choose the apps that eat the day, hold them
 * behind a shield on demand or in daily windows, lift it for a while, and
 * read today's minutes in them. The state is in Focus.swift, shared with the
 * monitor and shield extensions in targets/.
 *
 * A build without the Family Controls entitlement (MidnaFocus in Info.plist
 * is false, see app.config.js) says so in `status().available`, and the app
 * shows nothing of this.
 */
public class MidnaFocusModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MidnaFocus")

    Function("status") { () -> [String: Any] in
      let s = Focus.selection
      var status: [String: Any] = [
        "available": Bundle.main.object(forInfoDictionaryKey: "MidnaFocus") as? Bool ?? false,
        "authorized": AuthorizationCenter.shared.authorizationStatus == .approved,
        "apps": s.applicationTokens.count,
        "categories": s.categoryTokens.count,
        "sites": s.webDomainTokens.count,
        "held": Focus.held,
        "inWindow": !Focus.inWindows.isEmpty,
        "shielded": Focus.shielded,
        "windows": Focus.windows.map { ["start": $0.start, "end": $0.end] },
        "minutesToday": Focus.minutesToday,
        "hitsToday": Focus.hitsToday,
      ]
      if let until = Focus.liftedUntil { status["liftedUntil"] = until * 1000 }
      if let offer = Focus.offer { status["offer"] = ["title": offer.title, "url": offer.url as Any] }
      return status
    }

    /** Asks for Screen Time with Face ID or the passcode; iOS asks only until it's answered. */
    AsyncFunction("authorize") { () async throws -> Bool in
      try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
      return AuthorizationCenter.shared.authorizationStatus == .approved
    }

    /** Apple's picker for the apps, categories and sites to hold back; true when Justin chose (Done), false on Cancel. */
    AsyncFunction("pick") { (promise: Promise) in
      guard let top = self.appContext?.utilities?.currentViewController() else {
        promise.reject(NoScreen())
        return
      }
      var sheet: UIViewController?
      let view = PickSheet(selection: Focus.selection) { picked in
        sheet?.dismiss(animated: true)
        guard let picked else { return promise.resolve(false) }
        Focus.selection = picked
        do {
          try Focus.watchUsage()
        } catch {
          return promise.reject(error)
        }
        Focus.apply()
        promise.resolve(true)
      }
      sheet = UIHostingController(rootView: view)
      top.present(sheet!, animated: true)
    }.runOnQueue(.main)

    /** Hold the chosen apps now, until let go; letting go ends a lift too. Windows still hold them while they run. */
    Function("hold") { (on: Bool) in
      Focus.held = on
      if on { Focus.endLift() } else { Focus.apply() }
    }

    /** Lift the shield for this many minutes of use (at least a quarter hour of the clock). */
    Function("lift") { (minutes: Int) throws in
      try Focus.liftFor(minutes: minutes)
    }

    /** Put the shield back before a lift runs out. */
    Function("endLift") {
      Focus.endLift()
    }

    /** The daily windows that hold the apps: minutes after midnight, at most 8. */
    Function("setWindows") { (windows: [Window]) throws in
      try Focus.setWindows(windows.map { ($0.start, $0.end) })
    }

    /** What a shield offers instead (Justice, a study block) and the link that opens it. */
    Function("setOffer") { (title: String?, url: String?) in
      Focus.setOffer(title: title, url: url)
    }
  }
}

struct Window: Record {
  @Field var start: Int = 0
  @Field var end: Int = 0
}

struct PickSheet: View {
  @State var selection: FamilyActivitySelection
  let done: (FamilyActivitySelection?) -> Void

  var body: some View {
    NavigationView {
      FamilyActivityPicker(selection: $selection)
        .navigationTitle("Hold back")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { done(nil) } }
          ToolbarItem(placement: .confirmationAction) { Button("Done") { done(selection) } }
        }
    }
  }
}

final class NoScreen: Exception, @unchecked Sendable {
  override var reason: String {
    "There's no screen to show the picker on"
  }
}
