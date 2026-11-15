import CoreLocation
import ExpoModulesCore

/**
 * iOS's significant location changes, and nothing more: no GPS, no
 * continuous updates, no blue location pill. iOS wakes (or relaunches) the
 * app when the phone has moved about 500 m, and expo-task-manager runs the
 * JavaScript task registered under the name given here with the fixes.
 *
 * expo-location's own background updates start the GPS as well
 * (startUpdatingLocation), which midna was asked never to do.
 */
public class MidnaLocationModule: Module {
  private var taskManager: EXTaskManagerInterface? {
    appContext?.legacyModule(implementing: EXTaskManagerInterface.self)
  }

  public func definition() -> ModuleDefinition {
    Name("MidnaLocation")

    AsyncFunction("startSignificantChanges") { (taskName: String) in
      guard CLLocationManager.significantLocationChangeMonitoringAvailable() else {
        throw SignificantChangesUnavailable()
      }
      guard let taskManager = self.taskManager else {
        throw TaskManagerUnavailable()
      }
      taskManager.registerTask(withName: taskName, consumer: MidnaSignificantChangesConsumer.self, options: [:])
    }

    AsyncFunction("stopSignificantChanges") { (taskName: String) in
      guard let taskManager = self.taskManager,
        taskManager.task(withName: taskName, hasConsumerOf: MidnaSignificantChangesConsumer.self)
      else {
        return
      }
      taskManager.unregisterTask(withName: taskName, consumerClass: MidnaSignificantChangesConsumer.self)
    }

    AsyncFunction("hasStartedSignificantChanges") { (taskName: String) -> Bool in
      return self.taskManager?.task(withName: taskName, hasConsumerOf: MidnaSignificantChangesConsumer.self) ?? false
    }
  }
}

final class SignificantChangesUnavailable: Exception, @unchecked Sendable {
  override var reason: String {
    "This iPhone can't watch for significant location changes"
  }
}

final class TaskManagerUnavailable: Exception, @unchecked Sendable {
  override var reason: String {
    "expo-task-manager isn't available"
  }
}
