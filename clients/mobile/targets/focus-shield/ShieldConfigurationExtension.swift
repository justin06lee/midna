import ManagedSettings
import ManagedSettingsUI
import UIKit

/** The shield over a held app or site: what it is, and the better thing waiting (Focus.offer). */
class ShieldConfigurationExtension: ShieldConfigurationDataSource {
  override func configuration(shielding application: Application) -> ShieldConfiguration {
    shield(application.localizedDisplayName)
  }

  override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
    shield(application.localizedDisplayName)
  }

  override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
    shield(webDomain.domain)
  }

  override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration {
    shield(webDomain.domain)
  }

  private func shield(_ name: String?) -> ShieldConfiguration {
    Focus.recordHit()
    let what = name ?? "This"
    let minutes = Focus.minutesToday
    let spent = minutes > 0 ? " \(minutes) min in these today." : ""
    let offer = Focus.offer
    return ShieldConfiguration(
      backgroundBlurStyle: .systemThickMaterial,
      title: ShieldConfiguration.Label(text: "\(what) can wait", color: .label),
      subtitle: ShieldConfiguration.Label(
        text: (offer.map { "\($0.title) is waiting." } ?? "midna is holding it back.") + spent,
        color: .secondaryLabel),
      primaryButtonLabel: ShieldConfiguration.Label(text: offer.map { "Open \($0.title)" } ?? "Close", color: .white),
      primaryButtonBackgroundColor: .label,
      secondaryButtonLabel: ShieldConfiguration.Label(text: "Ask midna", color: .secondaryLabel))
  }
}
