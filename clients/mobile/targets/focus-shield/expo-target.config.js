/**
 * How a shield looks: what is held, and the better thing it offers.
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "shield-config",
  name: "focus-shield",
  bundleIdentifier: ".focus-shield",
  deploymentTarget: "16.4",
  frameworks: ["DeviceActivity", "FamilyControls", "ManagedSettings", "ManagedSettingsUI"],
  entitlements: {
    "com.apple.developer.family-controls": true,
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
