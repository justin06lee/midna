import CoreLocation
import ExpoModulesCore

/**
 * Where the phone is, for midna, through expo-task-manager: precise
 * background updates while it moves, significant changes as the net that
 * relaunches the app when iOS has ended it, and one fix on demand when midna
 * sends a silent push (MidnaLocationAppDelegateSubscriber). The work is in
 * MidnaSignificantChangesConsumer; expo-task-manager runs the JavaScript task
 * registered under the name given here with the fixes.
 */
public class MidnaLocationModule: Module {
  private var taskManager: EXTaskManagerInterface? {
    appContext?.legacyModule(implementing: EXTaskManagerInterface.self)
  }

  public func definition() -> ModuleDefinition {
    Name("MidnaLocation")

    /** Start, or change: `precise` adds the GPS updates (they run only with Always). Significant changes always run. */
    AsyncFunction("startTracking") { (taskName: String, precise: Bool) in
      guard CLLocationManager.significantLocationChangeMonitoringAvailable() else {
        throw SignificantChangesUnavailable()
      }
      guard let taskManager = self.taskManager else {
        throw TaskManagerUnavailable()
      }
      taskManager.registerTask(withName: taskName, consumer: MidnaSignificantChangesConsumer.self, options: ["precise": precise])
    }

    AsyncFunction("stopTracking") { (taskName: String) in
      guard let taskManager = self.taskManager,
        taskManager.task(withName: taskName, hasConsumerOf: MidnaSignificantChangesConsumer.self)
      else {
        return
      }
      taskManager.unregisterTask(withName: taskName, consumerClass: MidnaSignificantChangesConsumer.self)
    }

    AsyncFunction("isTracking") { (taskName: String) -> Bool in
      return self.taskManager?.task(withName: taskName, hasConsumerOf: MidnaSignificantChangesConsumer.self) ?? false
    }

    /** Whether iOS gives midna the phone's precise location (Precise Location on in Settings), not an approximate one. */
    Function("hasPreciseAccuracy") { () -> Bool in
      return CLLocationManager().accuracyAuthorization == .fullAccuracy
    }
  }
}

/**
 * midna's silent push (`midna: "locate"`, content-available): take one fix
 * now and send it, then tell iOS it's done. iOS wakes, or launches, the app
 * in the background for it and gives it about 30 s.
 */
public class MidnaLocationAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    guard (userInfo["midna"] as? String) == "locate" else {
      completionHandler(.noData)
      return
    }
    // Launched by the push, expo-task-manager may still be bringing the task back: give it a moment.
    func ask(_ tries: Int) {
      if let consumer = MidnaSignificantChangesConsumer.current {
        consumer.requestFix { ok in completionHandler(ok ? .newData : .failed) }
      } else if tries > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { ask(tries - 1) }
      } else {
        // Location is off in the app: nothing to send.
        completionHandler(.noData)
      }
    }
    DispatchQueue.main.async { ask(12) }
  }
}

final class SignificantChangesUnavailable: Exception, @unchecked Sendable {
  override var reason: String {
    "This iPhone can't watch for location changes"
  }
}

final class TaskManagerUnavailable: Exception, @unchecked Sendable {
  override var reason: String {
    "expo-task-manager isn't available"
  }
}
