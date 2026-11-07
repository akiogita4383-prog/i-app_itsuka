# いつか帳（iOS アプリ + Web 版）

現行の単一 HTML の PWA を Capacitor 8 で包んだ iOS アプリ。画面と保存処理は Web 版と同じ `www/index.html` を共有し、
iOS アプリのときだけネイティブ機能に差し替える（`window.ITSUKA_NATIVE`）。

```
www/                 アプリと Web 版で共通（index.html, icons/, capacitor.js）
web/                 Web 版だけのもの（sw.js, manifest.json, privacy.html, support.html）
ios/App/             Capacitor が生成した Xcode プロジェクト（SPM）
ios/ShareExtension/  共有シート受信（Swift）。Inbox.swift は本体にも含める
scripts/             setup-xcode.rb / make-assets.mjs / build-web.mjs / vendor.mjs
store/               ストア提出用の下書きと 1024px アイコン
```

## はじめて Mac でビルドするまで

1. Xcode をインストール（App Store）し、一度起動して追加コンポーネントを入れる
2. `npm install`
3. `npm run sync`（www を iOS プロジェクトへコピー）
4. `npm run open` で Xcode を開く
5. **App** と **ShareExtension** の両ターゲットで Signing & Capabilities → Team を選ぶ
   （App Groups `group.com.akioyamamoto.itsuka` は entitlements に設定済み。初回は Xcode が自動登録する）
6. iPhone をつないで Run

バンドル ID を変えるときは `scripts/setup-xcode.rb` 冒頭の `BUNDLE_ID` と `capacitor.config.json` の `appId` を変えて
`npm run xcode:setup` を実行する（何度実行しても同じ結果になる）。

## 日常の作業

| やること | コマンド |
|---|---|
| index.html を変えたあとアプリへ反映 | `npm run sync` |
| アイコン・スプラッシュの作り直し | `npm run assets` |
| GitHub Pages 用一式を作る | `npm run build:web` → `dist-web/` の中身を push |
| ブラウザで確認 | `npm run serve` → http://localhost:8787 |

Web 版を更新するときは従来どおり `web/sw.js` の `VERSION` を上げる。

## ネイティブ化で変わったところ

| 機能 | Web 版 | iOS アプリ |
|---|---|---|
| 共有シートから登録 | `?url=&title=&cat=`（ショートカット経由） | Share Extension → App Group → 本体が同じ受け取り口を呼ぶ |
| 写真 | `<input type=file>` | 「撮影する／写真を選ぶ（複数可）」→ ネイティブのカメラ・ピッカー |
| 共有送信 | `navigator.share` | ネイティブ共有シート（写真も添付） |
| チェック時 | — | 軽い触覚 |
| 書き出し | ダウンロード | ファイルを作って共有シートで保存（1件ずつ追記するので写真が多くても重くならない） |
| 文字サイズ | — | 端末の文字サイズ（Dynamic Type）に追従（0.85〜1.6倍） |
| フォント | Google Fonts（Zen Maru Gothic） | 端末の丸ゴシック（通信しないため） |
| Service Worker | あり | なし |
| 「共有から追加」の設定案内 | あり | 出さない |

共有拡張から本体を開く処理は、レスポンダチェーン経由の慣用的な方法を使っている。開けなかった場合でも、
共有コンテナに残した内容を本体の起動時・復帰時に読むので取りこぼさない。
