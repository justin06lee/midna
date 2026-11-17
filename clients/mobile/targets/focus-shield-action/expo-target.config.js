/**
 * A shield's buttons: a shield can't open an app, so each leaves a
 * notification that does (the offer, or midna's chat).
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "shield-action",
  name: "focus-shield-action",
  bundleIdentifier: ".focus-shield-action",
  deploymentTarget: "16.4",
  frameworks: ["DeviceActivity", "FamilyControls", "ManagedSettings", "UserNotifications"],
  entitlements: {
    "com.apple.developer.family-controls": true,
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
