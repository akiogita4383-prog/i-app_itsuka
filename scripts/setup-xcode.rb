# いつか帳: Xcode プロジェクトに Share Extension などを追加する（何度実行しても同じ結果になる）
#   ruby scripts/setup-xcode.rb
# バンドルIDと App Group を変えるときは下の3つを書き換えて再実行する。
require 'xcodeproj'

BUNDLE_ID   = 'com.akioyamamoto.itsuka'
APP_GROUP   = "group.#{BUNDLE_ID}"
DEPLOYMENT  = '16.0'
EXT_NAME    = 'ShareExtension'

root = File.expand_path('..', __dir__)
project = Xcodeproj::Project.open(File.join(root, 'ios/App/App.xcodeproj'))
app = project.targets.find { |t| t.name == 'App' } or abort 'App target not found'

# ---- プロジェクト共通 ----
project.build_configurations.each do |c|
  c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT
  c.build_settings['APP_GROUP_ID'] = APP_GROUP
end

# ---- 本体 ----
app.build_configurations.each do |c|
  s = c.build_settings
  s['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT
  s['TARGETED_DEVICE_FAMILY'] = '1'          # iPhone のみ
  s['PRODUCT_BUNDLE_IDENTIFIER'] = BUNDLE_ID
  s['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
  s['CODE_SIGN_STYLE'] = 'Automatic'
end

app_group = project.main_group.find_subpath('App', false) or abort 'App group not found'
def ensure_file(group, path)
  group.files.find { |f| f.path == path } || group.new_reference(path)
end

%w[MainViewController.swift ShareInboxPlugin.swift].each do |name|
  ref = ensure_file(app_group, name)
  app.source_build_phase.add_file_reference(ref, true)
end
ensure_file(app_group, 'App.entitlements')
privacy = ensure_file(app_group, 'PrivacyInfo.xcprivacy')
app.resources_build_phase.add_file_reference(privacy, true)

# ---- 共有拡張のファイル（ios/ShareExtension/） ----
ext_group = project.main_group.children.find { |g| g.display_name == EXT_NAME } ||
            project.main_group.new_group(EXT_NAME, '../ShareExtension')
inbox   = ensure_file(ext_group, 'Inbox.swift')
vc      = ensure_file(ext_group, 'ShareViewController.swift')
ensure_file(ext_group, 'Info.plist')
ensure_file(ext_group, 'ShareExtension.entitlements')

# 受け渡しの取り決めは本体にも含める
app.source_build_phase.add_file_reference(inbox, true)

# ---- 共有拡張ターゲット ----
ext = project.targets.find { |t| t.name == EXT_NAME }
unless ext
  ext = project.new_target(:app_extension, EXT_NAME, :ios, DEPLOYMENT, project.products_group, :swift)
end
ext.source_build_phase.add_file_reference(inbox, true)
ext.source_build_phase.add_file_reference(vc, true)

ext.build_configurations.each do |c|
  s = c.build_settings
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['PRODUCT_BUNDLE_IDENTIFIER'] = "#{BUNDLE_ID}.#{EXT_NAME}"
  s['INFOPLIST_FILE'] = '../ShareExtension/Info.plist'
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['CODE_SIGN_ENTITLEMENTS'] = '../ShareExtension/ShareExtension.entitlements'
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT
  s['TARGETED_DEVICE_FAMILY'] = '1'
  s['SWIFT_VERSION'] = '5.0'
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  s['SKIP_INSTALL'] = 'YES'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  # 本体とバージョン番号をそろえる（不一致だと提出時に警告になる）
  app_c = app.build_configurations.find { |a| a.name == c.name }
  s['MARKETING_VERSION'] = app_c.build_settings['MARKETING_VERSION'] || '1.0'
  s['CURRENT_PROJECT_VERSION'] = app_c.build_settings['CURRENT_PROJECT_VERSION'] || '1'
end

# 本体に埋め込む
app.add_dependency(ext) unless app.dependencies.any? { |d| d.target == ext }
embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' }
unless embed
  embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
end
unless embed.files_references.include?(ext.product_reference)
  bf = embed.add_file_reference(ext.product_reference, true)
  bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

project.save
puts "OK: #{BUNDLE_ID} / #{APP_GROUP} / iOS #{DEPLOYMENT}"
