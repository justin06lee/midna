import CoreLocation
import ExpoModulesCore

/**
 * The task consumer behind MidnaLocation. expo-task-manager makes one again
 * at each launch, a relaunch for a location event included, so it carries on
 * after iOS stopped the app or the phone restarted. (The name is from when it
 * watched significant changes only; expo-task-manager keeps it in the saved
 * task, so it stays.)
 *
 * - Precise (option `precise`, and only with Always): standard updates, best
 *   accuracy, a fix every 30 m of movement, in the background too. iOS pauses
 *   them once the phone sits still; a 100 m region around where it stopped
 *   wakes them when it moves on.
 * - Always: significant location changes (about 500 m). When iOS has ended
 *   the app, they relaunch it, and this starts the precise updates again.
 * - On demand (`requestFix`): one fix now, for midna's silent push.
 *
 * The task gets `{ locations: [{ coords: { latitude, longitude, accuracy,
 * altitude, speed }, timestamp, source }] }`, the shape expo-location's tasks
 * have plus where each fix came from ("precise", "significant",
 * "requested"), or `{ locations: [], flush: true }` when the updates pause,
 * so what waits is sent before the phone goes quiet.
 */
@objc(MidnaSignificantChangesConsumer)
final class MidnaSignificantChangesConsumer: NSObject, EXTaskConsumerInterface, CLLocationManagerDelegate {
  /** The consumer of the running task, for the silent push's fix. */
  static weak var current: MidnaSignificantChangesConsumer?

  static let resumeRegionId = "midna:resume"
  static let resumeRadius: CLLocationDistance = 100
  static let distanceFilter: CLLocationDistance = 30
  /** How long a requested fix may take, the JavaScript sending it included; iOS gives a silent push about 30 s. */
  static let requestBudget: TimeInterval = 25

  var task: (any EXTaskInterface)?
  /** Significant changes and the resume region. */
  private var safety: CLLocationManager?
  /** The precise updates. */
  private var tracker: CLLocationManager?
  private var tracking = false
  private var wantsPrecise = false
  /** One fix at a time, on demand. */
  private var asker: CLLocationManager?
  /** Asks waiting for the fix. */
  private var asked: [UUID: (Bool) -> Void] = [:]
  /** Asks whose fix went to JavaScript, waiting for it to finish sending. */
  private var sending: [UUID: (Bool) -> Void] = [:]

  func taskType() -> String {
    return "significantLocationChanges"
  }

  func didRegisterTask(_ task: any EXTaskInterface) {
    self.task = task
    Self.current = self
    apply(task.options)
  }

  func setOptions(_ options: [AnyHashable: Any]) {
    apply(options)
  }

  private func apply(_ options: [AnyHashable: Any]?) {
    let precise = (options?["precise"] as? Bool) ?? false
    DispatchQueue.main.async {
      Self.current = self
      let safety = self.safety ?? CLLocationManager()
      self.safety = safety
      safety.delegate = self
      safety.startMonitoringSignificantLocationChanges()
      self.wantsPrecise = precise
      self.track()
    }
  }

  func didUnregister() {
    DispatchQueue.main.async {
      self.stopTracking()
      self.safety?.stopMonitoringSignificantLocationChanges()
      self.stopResumeRegion()
      self.safety?.delegate = nil
      self.safety = nil
      self.tracker?.delegate = nil
      self.tracker = nil
      for id in Array(self.asked.keys) + Array(self.sending.keys) { self.settle(id, false) }
      if Self.current === self { Self.current = nil }
    }
    task = nil
  }

  /** JavaScript finished with an execution: a requested fix has been sent (or tried). */
  func didFinish() {
    DispatchQueue.main.async {
      for id in Array(self.sending.keys) { self.settle(id, true) }
    }
  }

  // ── precise ───────────────────────────────────────────────────────────

  /** Precise updates run when asked for and iOS allows Always; with less, they'd stop at the lock screen anyway. */
  private func track() {
    let always = (safety?.authorizationStatus ?? .notDetermined) == .authorizedAlways
    if wantsPrecise && always { startTracking() } else { stopTracking() }
  }

  private func startTracking() {
    let m = tracker ?? CLLocationManager()
    tracker = m
    m.delegate = self
    m.desiredAccuracy = kCLLocationAccuracyBest
    m.distanceFilter = Self.distanceFilter
    m.activityType = .other
    // Sitting still for a while pauses the GPS (the battery's sake); the resume region and significant changes start it again.
    m.pausesLocationUpdatesAutomatically = true
    m.allowsBackgroundLocationUpdates = true
    m.showsBackgroundLocationIndicator = false
    m.startUpdatingLocation()
    tracking = true
    stopResumeRegion()
  }

  private func stopTracking() {
    guard tracking else { return }
    tracker?.stopUpdatingLocation()
    tracking = false
  }

  private func resume() {
    guard tracking, let tracker else { return }
    stopResumeRegion()
    tracker.startUpdatingLocation()
  }

  private func stopResumeRegion() {
    guard let safety else { return }
    for r in safety.monitoredRegions where r.identifier == Self.resumeRegionId {
      safety.stopMonitoring(for: r)
    }
  }

  func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
    guard manager === tracker else { return }
    if let here = manager.location, let safety {
      let r = CLCircularRegion(center: here.coordinate, radius: Self.resumeRadius, identifier: Self.resumeRegionId)
      r.notifyOnEntry = false
      r.notifyOnExit = true
      safety.startMonitoring(for: r)
    }
    task?.execute(withData: ["locations": [] as [Any], "flush": true], withError: nil)
  }

  func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
    if manager === tracker { stopResumeRegion() }
  }

  func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
    if manager === safety && region.identifier == Self.resumeRegionId { resume() }
  }

  func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
    // Out of regions (the saved places take them): significant changes resume the updates instead.
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager === safety { track() }
  }

  // ── on demand ─────────────────────────────────────────────────────────

  /** One fix now, sent to midna through the task; `done(true)` once JavaScript has had it, false when there was none in time. Main thread. */
  func requestFix(_ done: @escaping (Bool) -> Void) {
    let id = UUID()
    asked[id] = done
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.requestBudget) { [weak self] in self?.settle(id, false) }
    guard asked.count == 1 else { return }
    let m = asker ?? CLLocationManager()
    asker = m
    m.delegate = self
    m.desiredAccuracy = kCLLocationAccuracyBest
    m.requestLocation()
  }

  private func settle(_ id: UUID, _ ok: Bool) {
    if let done = asked.removeValue(forKey: id) ?? sending.removeValue(forKey: id) { done(ok) }
  }

  // ── fixes ─────────────────────────────────────────────────────────────

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard !locations.isEmpty else {
      return
    }
    if manager === asker {
      guard !asked.isEmpty else { return }
      // Hand the asks over: each is done once JavaScript has sent the fix (didFinish), or its budget runs out.
      sending.merge(asked) { a, _ in a }
      asked = [:]
      task?.execute(withData: ["locations": locations.suffix(1).map { Self.export($0, "requested") }], withError: nil)
      return
    }
    let source = manager === tracker ? "precise" : "significant"
    // A significant change while the precise updates were paused: they start again from here.
    if manager === safety && tracking { resume() }
    task?.execute(withData: ["locations": locations.map { Self.export($0, source) }], withError: nil)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    if manager === asker {
      for id in Array(asked.keys) { settle(id, false) }
      return
    }
    // Not knowing for a moment is no news; iOS keeps trying on its own.
    if let error = error as? CLError, error.code == .locationUnknown {
      return
    }
    task?.execute(withData: nil, withError: error)
  }

  private static func export(_ l: CLLocation, _ source: String) -> [String: Any] {
    var coords: [String: Any] = [
      "latitude": l.coordinate.latitude,
      "longitude": l.coordinate.longitude,
    ]
    if l.horizontalAccuracy >= 0 { coords["accuracy"] = l.horizontalAccuracy }
    if l.verticalAccuracy >= 0 { coords["altitude"] = l.altitude }
    if l.speed >= 0 { coords["speed"] = l.speed }
    return ["coords": coords, "timestamp": l.timestamp.timeIntervalSince1970 * 1000, "source": source]
  }
}
