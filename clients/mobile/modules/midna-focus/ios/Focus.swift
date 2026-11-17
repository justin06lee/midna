import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings

/**
 * What the app and its Screen Time extensions share: the apps Justin chose
 * to hold back, whether they are held, the daily windows that hold them, a
 * lift and when it runs out, today's minutes in them, and the better thing a
 * shield offers. All of it lives in the app group, since the extensions run
 * when the app doesn't. The app's copy is in modules/midna-focus/ios; each
 * target in targets/ links to it.
 *
 * A shield is up when the apps are held (on demand, or inside a window) and
 * no lift is running.
 */
enum Focus {
  static let group = "group.sh.midna.mobile"
  static let defaults = UserDefaults(suiteName: group) ?? .standard
  static let store = ManagedSettingsStore(named: ManagedSettingsStore.Name("midna"))
  static let center = DeviceActivityCenter()

  static let usage = DeviceActivityName("midna.usage")
  static let lift = DeviceActivityName("midna.lift")
  static let windowPrefix = "midna.window."
  /** iOS monitors at most about 20 activities per app: usage, a lift, and the windows. */
  static let maxWindows = 8
  /** DeviceActivity refuses an interval shorter than this. */
  static let minInterval: TimeInterval = 15 * 60
  /** Today's minutes are known in steps of this many, up to `usageCap` (one threshold event each). */
  static let usageStep = 15
  static let usageCap = 300

  // MARK: what is chosen

  static var selection: FamilyActivitySelection {
    get {
      guard let data = defaults.data(forKey: "selection"),
        let s = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data)
      else { return FamilyActivitySelection() }
      return s
    }
    set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "selection") }
  }

  static var chosen: Bool {
    let s = selection
    return !(s.applicationTokens.isEmpty && s.categoryTokens.isEmpty && s.webDomainTokens.isEmpty)
  }

  /** The better thing a shield offers: a book or a study block, and a link that opens it. */
  static var offer: (title: String, url: String?)? {
    guard let title = defaults.string(forKey: "offer.title"), !title.isEmpty else { return nil }
    return (title, defaults.string(forKey: "offer.url"))
  }

  static func setOffer(title: String?, url: String?) {
    defaults.set(title, forKey: "offer.title")
    defaults.set(url, forKey: "offer.url")
  }

  // MARK: holding and lifting

  /** Held on demand, until let go. */
  static var held: Bool {
    get { defaults.bool(forKey: "held") }
    set { defaults.set(newValue, forKey: "held") }
  }

  /** Windows running now, by activity name. */
  static var inWindows: Set<String> {
    get { Set(defaults.stringArray(forKey: "inWindows") ?? []) }
    set { defaults.set(Array(newValue), forKey: "inWindows") }
  }

  /** When a running lift runs out (seconds since 1970), else nil. */
  static var liftedUntil: Double? {
    get { defaults.object(forKey: "liftedUntil") as? Double }
    set { defaults.set(newValue, forKey: "liftedUntil") }
  }

  static var shielded: Bool { store.shield.applications != nil || store.shield.applicationCategories != nil || store.shield.webDomains != nil }

  /** Put the shield where it should be now. */
  static func apply(now: Date = Date()) {
    if let until = liftedUntil, until <= now.timeIntervalSince1970 { liftedUntil = nil }
    let up = (held || !inWindows.isEmpty) && liftedUntil == nil && chosen
    if up {
      let s = selection
      store.shield.applications = s.applicationTokens.isEmpty ? nil : s.applicationTokens
      store.shield.applicationCategories = s.categoryTokens.isEmpty ? nil : .specific(s.categoryTokens)
      store.shield.webDomains = s.webDomainTokens.isEmpty ? nil : s.webDomainTokens
      store.shield.webDomainCategories = s.categoryTokens.isEmpty ? nil : .specific(s.categoryTokens)
    } else {
      store.shield.applications = nil
      store.shield.applicationCategories = nil
      store.shield.webDomains = nil
      store.shield.webDomainCategories = nil
    }
  }

  /**
   * Lift the shield for `minutes` of use of the held apps, or a quarter of an
   * hour of the clock if that is longer, whichever ends first. The monitor
   * extension puts it back, with the app closed.
   */
  static func liftFor(minutes: Int, now: Date = Date()) throws {
    let minutes = max(1, minutes)
    let end = now.addingTimeInterval(max(minInterval, TimeInterval(minutes * 60)))
    center.stopMonitoring([lift])
    let parts: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]
    let schedule = DeviceActivitySchedule(
      intervalStart: Calendar.current.dateComponents(parts, from: now),
      intervalEnd: Calendar.current.dateComponents(parts, from: end),
      repeats: false)
    let s = selection
    let used = DeviceActivityEvent(applications: s.applicationTokens, categories: s.categoryTokens, webDomains: s.webDomainTokens, threshold: DateComponents(minute: minutes))
    try center.startMonitoring(lift, during: schedule, events: [DeviceActivityEvent.Name("used"): used])
    liftedUntil = end.timeIntervalSince1970
    apply(now: now)
  }

  /** The lift is over: its minutes are used, its time is up, or Justin put the shield back. */
  static func endLift() {
    center.stopMonitoring([lift])
    liftedUntil = nil
    apply()
  }

  // MARK: windows

  /** Daily windows, each as minutes after midnight; one that ends before it starts runs past midnight. */
  static var windows: [(start: Int, end: Int)] {
    (defaults.array(forKey: "windows") as? [[Int]] ?? []).compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
  }

  static func setWindows(_ list: [(start: Int, end: Int)]) throws {
    let old = center.activities.filter { $0.rawValue.hasPrefix(windowPrefix) }
    center.stopMonitoring(old)
    inWindows = []
    let list = Array(list.prefix(maxWindows))
    defaults.set(list.map { [$0.start, $0.end] }, forKey: "windows")
    for (i, w) in list.enumerated() {
      let schedule = DeviceActivitySchedule(
        intervalStart: DateComponents(hour: w.start / 60, minute: w.start % 60),
        intervalEnd: DateComponents(hour: w.end / 60, minute: w.end % 60),
        repeats: true)
      try center.startMonitoring(DeviceActivityName("\(windowPrefix)\(i)"), during: schedule)
    }
    apply()
  }

  // MARK: how much

  static func today(_ now: Date = Date()) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: now)
  }

  /** Minutes in the held apps today, known to the last `usageStep`. */
  static var minutesToday: Int {
    defaults.string(forKey: "usage.day") == today() ? defaults.integer(forKey: "usage.minutes") : 0
  }

  static func recordMinutes(_ minutes: Int) {
    let day = today()
    let had = defaults.string(forKey: "usage.day") == day ? defaults.integer(forKey: "usage.minutes") : 0
    defaults.set(day, forKey: "usage.day")
    defaults.set(max(had, minutes), forKey: "usage.minutes")
  }

  /** Times a shield was met today. */
  static var hitsToday: Int {
    defaults.string(forKey: "hits.day") == today() ? defaults.integer(forKey: "hits.count") : 0
  }

  /** A shield was shown. iOS asks for its look more than once a sighting, so a minute counts once. */
  static func recordHit(now: Date = Date()) {
    let last = defaults.double(forKey: "hits.last")
    if now.timeIntervalSince1970 - last < 60 { return }
    let day = today(now)
    defaults.set(now.timeIntervalSince1970, forKey: "hits.last")
    defaults.set((defaults.string(forKey: "hits.day") == day ? defaults.integer(forKey: "hits.count") : 0) + 1, forKey: "hits.count")
    defaults.set(day, forKey: "hits.day")
  }

  /** Watch today's use of the chosen apps, all day every day, in `usageStep` steps. Again whenever the choice changes. */
  static func watchUsage() throws {
    center.stopMonitoring([usage])
    guard chosen else { return }
    let s = selection
    var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
    for m in stride(from: usageStep, through: usageCap, by: usageStep) {
      let threshold = DateComponents(minute: m)
      if #available(iOS 17.4, *) {
        // Started mid-day, count what came before too.
        events[DeviceActivityEvent.Name("m\(m)")] = DeviceActivityEvent(applications: s.applicationTokens, categories: s.categoryTokens, webDomains: s.webDomainTokens, threshold: threshold, includesPastActivity: true)
      } else {
        events[DeviceActivityEvent.Name("m\(m)")] = DeviceActivityEvent(applications: s.applicationTokens, categories: s.categoryTokens, webDomains: s.webDomainTokens, threshold: threshold)
      }
    }
    let day = DeviceActivitySchedule(intervalStart: DateComponents(hour: 0, minute: 0), intervalEnd: DateComponents(hour: 23, minute: 59), repeats: true)
    try center.startMonitoring(usage, during: day, events: events)
  }
}
