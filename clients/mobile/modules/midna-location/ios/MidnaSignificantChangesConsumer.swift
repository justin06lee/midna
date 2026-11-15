import CoreLocation
import ExpoModulesCore

/**
 * The task consumer behind MidnaLocation: a location manager that only
 * monitors significant changes. expo-task-manager makes one again at each
 * launch, a relaunch for a location event included, so monitoring carries
 * on after the app was closed or the phone restarted.
 *
 * The task gets `{ locations: [{ coords: { latitude, longitude, accuracy,
 * altitude, speed }, timestamp }] }`, the shape expo-location's tasks have.
 */
@objc(MidnaSignificantChangesConsumer)
final class MidnaSignificantChangesConsumer: NSObject, EXTaskConsumerInterface, CLLocationManagerDelegate {
  var task: (any EXTaskInterface)?
  private var manager: CLLocationManager?

  func taskType() -> String {
    return "significantLocationChanges"
  }

  func didRegisterTask(_ task: any EXTaskInterface) {
    self.task = task
    DispatchQueue.main.async {
      let manager = self.manager ?? CLLocationManager()
      self.manager = manager
      manager.delegate = self
      manager.startMonitoringSignificantLocationChanges()
    }
  }

  func didUnregister() {
    DispatchQueue.main.async {
      self.manager?.stopMonitoringSignificantLocationChanges()
      self.manager?.delegate = nil
      self.manager = nil
    }
    task = nil
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard !locations.isEmpty else {
      return
    }
    task?.execute(withData: ["locations": locations.map(Self.export)], withError: nil)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Not knowing for a moment is no news; iOS keeps trying on its own.
    if let error = error as? CLError, error.code == .locationUnknown {
      return
    }
    task?.execute(withData: nil, withError: error)
  }

  private static func export(_ l: CLLocation) -> [String: Any] {
    var coords: [String: Any] = [
      "latitude": l.coordinate.latitude,
      "longitude": l.coordinate.longitude,
    ]
    if l.horizontalAccuracy >= 0 { coords["accuracy"] = l.horizontalAccuracy }
    if l.verticalAccuracy >= 0 { coords["altitude"] = l.altitude }
    if l.speed >= 0 { coords["speed"] = l.speed }
    return ["coords": coords, "timestamp": l.timestamp.timeIntervalSince1970 * 1000]
  }
}
