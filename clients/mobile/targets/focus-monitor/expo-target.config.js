/**
 * Runs when the app doesn't: windows open and close, a lift runs out, and
 * today's minutes in the held apps cross each quarter hour (Focus.swift).
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "device-activity-monitor",
  name: "focus-monitor",
  bundleIdentifier: ".focus-monitor",
  deploymentTarget: "16.4",
  frameworks: ["DeviceActivity", "FamilyControls", "ManagedSettings"],
  entitlements: {
    "com.apple.developer.family-controls": true,
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
