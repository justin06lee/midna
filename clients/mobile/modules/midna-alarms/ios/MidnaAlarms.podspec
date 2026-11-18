Pod::Spec.new do |s|
  s.name           = 'MidnaAlarms'
  s.version        = '0.1.0'
  s.summary        = "midna's alarms, given to iOS's own (AlarmKit, iOS 26): they ring through silent mode and a Focus"
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'midna'
  s.homepage       = 'https://github.com/justin06lee/midna'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,swift}'
end
