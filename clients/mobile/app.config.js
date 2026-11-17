/**
 * app.json, and with MIDNA_FOCUS=1 Screen Time (docs/screen-time.md): the
 * Family Controls entitlement and app group for the app, and the monitor and
 * shield extensions in targets/ (through @bacons/apple-targets). Without it
 * the build is the app as before: the Screen Time module is in it, but says
 * it isn't available and Settings shows nothing of it. A build for
 * TestFlight can turn it on only once Apple has granted the team Family
 * Controls (Distribution).
 */
module.exports = ({ config }) => {
  if (process.env.MIDNA_FOCUS !== "1") return config;
  return {
    ...config,
    ios: {
      ...config.ios,
      entitlements: {
        ...config.ios.entitlements,
        "com.apple.developer.family-controls": true,
        "com.apple.security.application-groups": ["group.sh.midna.mobile"],
      },
      infoPlist: { ...config.ios.infoPlist, MidnaFocus: true },
    },
    plugins: [...config.plugins, "@bacons/apple-targets"],
  };
};
