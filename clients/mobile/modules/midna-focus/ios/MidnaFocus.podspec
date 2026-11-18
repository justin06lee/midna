Pod::Spec.new do |s|
  s.name           = 'MidnaFocus'
  s.version        = '0.1.0'
  s.summary        = 'Screen Time on Justin\'s own phone: shields on the apps he chooses, lifts, daily windows and today\'s minutes'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'midna'
  s.homepage       = 'https://github.com/justin06lee/midna'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'FamilyControls', 'ManagedSettings', 'DeviceActivity', 'SwiftUI'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,swift}'
end
