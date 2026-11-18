import ExpoModulesCore

/**
 * midna's alarms on this phone, handed to iOS's own alarms (AlarmKit, iOS
 * 26): they ring out loud through silent mode and a Focus, as the Clock
 * app's do. midna holds the list; JavaScript brings it here (as JSON, and
 * gets JSON back) and tells midna what iOS holds. The work is in
 * Alarms.swift, which knows nothing of Expo.
 */
public class MidnaAlarmsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MidnaAlarms")

    /** "authorized", "denied", "notDetermined", or "unsupported" before iOS 26. */
    Function("authorization") { () -> String in
      return MidnaAlarms.authorization()
    }

    /** iOS asks the user once; afterwards this only says how it stands. */
    AsyncFunction("requestAuthorization") { () async -> String in
      return await MidnaAlarms.requestAuthorization()
    }

    /**
     * Make iOS hold exactly midna's alarms (a JSON array of them), asking the
     * user to allow alarms first when `ask` and they haven't been asked. The
     * answer is JSON: the authorization, the alarms iOS holds, and the ones
     * it refused.
     */
    AsyncFunction("sync") { (alarms: String, ask: Bool) async -> String in
      return await MidnaAlarms.sync(json: alarms, ask: ask)
    }
  }
}
