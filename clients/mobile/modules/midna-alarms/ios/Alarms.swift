import Foundation
#if canImport(AlarmKit)
import AlarmKit
import SwiftUI
#endif

/** One alarm, as midna holds it (packages/protocol/src/alarms.ts). */
struct MidnaAlarm: Codable {
  let id: String
  let label: String
  /** A one-off alarm: when it rings, ms since the epoch. */
  let at: Int64?
  /** A recurring alarm: "HH:MM" on this phone's clock. */
  let time: String?
  /** A recurring alarm: its ISO weekdays, 1 is Monday. */
  let days: [Int]?
  /** midna's version of it: iOS holds this one, or an older one to replace. */
  let updatedAt: Int64
}

/** What iOS holds after going through midna's list: the phone's answer to midna. */
struct AlarmsHeld: Codable {
  struct Held: Codable {
    let id: String
    let updatedAt: Int64
  }
  struct Problem: Codable {
    let id: String
    let error: String
  }
  var authorization: String
  var scheduled: [Held] = []
  var problems: [Problem] = []
}

/** midna's alarms on this phone. Before iOS 26 there are none: "unsupported". */
enum MidnaAlarms {
  static func authorization() -> String {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      return AlarmKitSide.name(AlarmManager.shared.authorizationState)
    }
    #endif
    return "unsupported"
  }

  static func requestAuthorization() async -> String {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      return AlarmKitSide.name(await AlarmKitSide.authorize(ask: true))
    }
    #endif
    return "unsupported"
  }

  /** `json` is midna's list; the answer is an AlarmsHeld as JSON. */
  static func sync(json: String, ask: Bool) async -> String {
    var held = AlarmsHeld(authorization: "unsupported")
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      do {
        let wanted = try JSONDecoder().decode([MidnaAlarm].self, from: Data(json.utf8))
        held = await AlarmKitSide.sync(wanted, ask: ask)
      } catch {
        held = AlarmsHeld(authorization: authorization(), problems: [AlarmsHeld.Problem(id: "", error: "the list couldn't be read: \(error)")])
      }
    }
    #endif
    guard let data = try? JSONEncoder().encode(held), let text = String(data: data, encoding: .utf8) else {
      return "{\"authorization\":\"unsupported\",\"scheduled\":[],\"problems\":[]}"
    }
    return text
  }
}

#if canImport(AlarmKit)
@available(iOS 26.0, *)
enum AlarmKitSide {
  /** midna's alarms carry nothing of their own into the alarm's screen. */
  struct NoMetadata: AlarmMetadata {}

  /** The version of each alarm iOS holds, by its id (lowercase): iOS keeps the alarm, not which version of midna's it was. */
  static let versionsKey = "midna.alarms.versions"

  static func name(_ state: AlarmManager.AuthorizationState) -> String {
    switch state {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    @unknown default: return "notDetermined"
    }
  }

  static func authorize(ask: Bool) async -> AlarmManager.AuthorizationState {
    let manager = AlarmManager.shared
    let state = manager.authorizationState
    guard ask, state == .notDetermined else { return state }
    return (try? await manager.requestAuthorization()) ?? manager.authorizationState
  }

  /**
   * Make iOS hold exactly `wanted`: an alarm gone from the list, or changed
   * since iOS was given it, is cancelled; one iOS doesn't hold is scheduled.
   * A one-off whose time has passed is left alone (it rang, or the phone was
   * off). What iOS holds afterwards is the answer.
   */
  static func sync(_ wanted: [MidnaAlarm], ask: Bool) async -> AlarmsHeld {
    let state = await authorize(ask: ask)
    var out = AlarmsHeld(authorization: name(state))
    guard state == .authorized else { return out }
    let manager = AlarmManager.shared

    var want: [UUID: MidnaAlarm] = [:]
    for alarm in wanted {
      if let id = UUID(uuidString: alarm.id) {
        want[id] = alarm
      } else {
        out.problems.append(AlarmsHeld.Problem(id: alarm.id, error: "its id isn't a UUID"))
      }
    }

    let current: [Alarm]
    do {
      current = try manager.alarms
    } catch {
      out.problems.append(AlarmsHeld.Problem(id: "", error: "iOS didn't say which alarms it holds: \(error)"))
      return out
    }

    var versions = UserDefaults.standard.dictionary(forKey: versionsKey) as? [String: String] ?? [:]
    var held = Set<UUID>()
    var stuck = Set<UUID>()
    for alarm in current {
      let key = alarm.id.uuidString.lowercased()
      if let mine = want[alarm.id], versions[key] == String(mine.updatedAt) {
        held.insert(alarm.id)
        continue
      }
      do {
        try manager.cancel(id: alarm.id)
        versions[key] = nil
      } catch {
        // Still held as it was: its new version can't take its place.
        stuck.insert(alarm.id)
        out.problems.append(AlarmsHeld.Problem(id: want[alarm.id]?.id ?? key, error: "iOS wouldn't cancel the old one: \(error)"))
      }
    }

    let now = Date()
    for (id, alarm) in want where !held.contains(id) && !stuck.contains(id) {
      guard let schedule = schedule(for: alarm, now: now) else { continue }
      do {
        _ = try await manager.schedule(id: id, configuration: configuration(for: alarm, schedule: schedule))
        held.insert(id)
        versions[id.uuidString.lowercased()] = String(alarm.updatedAt)
      } catch {
        out.problems.append(AlarmsHeld.Problem(id: alarm.id, error: "\(error)"))
      }
    }

    let wantedKeys = Set(want.keys.map { $0.uuidString.lowercased() })
    UserDefaults.standard.set(versions.filter { wantedKeys.contains($0.key) }, forKey: versionsKey)
    out.scheduled = want.filter { held.contains($0.key) }.map { AlarmsHeld.Held(id: $0.value.id, updatedAt: $0.value.updatedAt) }
    return out
  }

  static let weekdays: [Int: Locale.Weekday] = [1: .monday, 2: .tuesday, 3: .wednesday, 4: .thursday, 5: .friday, 6: .saturday, 7: .sunday]

  /** When it rings: once at an instant, or on its weekdays by this phone's clock. Nil for a one-off that is past, or an alarm that says neither. */
  static func schedule(for alarm: MidnaAlarm, now: Date) -> Alarm.Schedule? {
    if let at = alarm.at {
      let date = Date(timeIntervalSince1970: Double(at) / 1000)
      return date > now ? .fixed(date) : nil
    }
    let parts = (alarm.time ?? "").split(separator: ":").compactMap { Int($0) }
    let days = (alarm.days ?? []).compactMap { weekdays[$0] }
    guard parts.count == 2, !days.isEmpty else { return nil }
    let time = Alarm.Schedule.Relative.Time(hour: parts[0], minute: parts[1])
    return .relative(Alarm.Schedule.Relative(time: time, repeats: .weekly(days)))
  }

  /**
   * An alarm as the Clock app's: the label over a Stop button, the system's
   * alarm sound, no snooze and no countdown (a countdown needs a widget
   * extension, without which iOS may drop the alarm).
   */
  static func configuration(for alarm: MidnaAlarm, schedule: Alarm.Schedule) -> AlarmManager.AlarmConfiguration<NoMetadata> {
    // The initializer that takes a stop button is the one every iOS 26 SDK has; from 26.1 iOS draws its own and ignores this one.
    let alert = AlarmPresentation.Alert(
      title: LocalizedStringResource(stringLiteral: alarm.label),
      stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle")
    )
    let attributes = AlarmAttributes<NoMetadata>(presentation: AlarmPresentation(alert: alert), tintColor: .orange)
    return .alarm(schedule: schedule, attributes: attributes)
  }
}
#endif
