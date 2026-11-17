import DeviceActivity
import Foundation

/** What Screen Time tells midna while the app is closed; Focus.swift decides what the shield does. */
class DeviceActivityMonitorExtension: DeviceActivityMonitor {
  override func intervalDidStart(for activity: DeviceActivityName) {
    super.intervalDidStart(for: activity)
    guard activity.rawValue.hasPrefix(Focus.windowPrefix) else { return }
    Focus.inWindows.insert(activity.rawValue)
    Focus.apply()
  }

  override func intervalDidEnd(for activity: DeviceActivityName) {
    super.intervalDidEnd(for: activity)
    if activity == Focus.lift {
      Focus.endLift()
    } else if activity.rawValue.hasPrefix(Focus.windowPrefix) {
      Focus.inWindows.remove(activity.rawValue)
      Focus.apply()
    }
  }

  override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
    super.eventDidReachThreshold(event, activity: activity)
    if activity == Focus.lift {
      // The lift's minutes are used up.
      Focus.endLift()
    } else if activity == Focus.usage, event.rawValue.hasPrefix("m"), let minutes = Int(event.rawValue.dropFirst()) {
      Focus.recordMinutes(minutes)
    }
  }
}
