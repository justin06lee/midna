import ExpoModulesCore
import FamilyControls
import SwiftUI

/**
 * Screen Time for midna, on Justin's own phone (FamilyControls with
 * individual authorization): choose the apps that eat the day, and carry out
 * midna's rules for them (a shield on demand or in daily windows, lifts with
 * a reason), and say how the days went. The state is in Focus.swift, shared
 * with the monitor and shield extensions in targets/.
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
      if let until = Focus.heldUntil { status["heldUntil"] = until * 1000 }
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

    /** midna's rules (FocusRules), fetched or from a silent push: the hold, the windows, the offer, and a lift not yet applied. */
    Function("applyRules") { (rules: [String: Any]) throws in
      try Focus.applyRules(rules)
    }

    /** What midna is told (FocusReport): two weeks of minutes and shields met, and how Screen Time stands. */
    Function("report") { () -> [String: Any] in
      Focus.report()
    }

    /** Lift the shield at once for this many minutes of use, for the lift midna recorded as `id` (so its rules don't lift again). */
    Function("lift") { (minutes: Int, id: String?) throws in
      if let id { Focus.markLiftApplied(id) }
      try Focus.liftFor(minutes: minutes)
    }

    /** Put the shield back before a lift runs out. */
    Function("endLift") {
      Focus.endLift()
    }
  }
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
