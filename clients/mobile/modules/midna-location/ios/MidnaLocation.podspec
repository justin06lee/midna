Pod::Spec.new do |s|
  s.name           = 'MidnaLocation'
  s.version        = '0.1.0'
  s.summary        = 'Precise background location, significant changes as a safety net, and one fix on a silent push, through expo-task-manager'
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
