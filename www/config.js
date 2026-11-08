// いつか帳の設定。秘密の値は入れない（ここはアプリにそのまま入る）。
// supabaseUrl / supabaseAnonKey が空のあいだは共有帳の機能は出ず、個人用の帳だけで動く。
window.ITSUKA_CONFIG = {
  // Supabase → Project Settings → API の「Project URL」と「anon public」キー
  supabaseUrl: '',
  supabaseAnonKey: '',

  // 招待リンクの受け口（web/join.html を GitHub Pages に置いた場所）
  inviteBase: 'https://akiogita4383-prog.github.io/i-app_itsuka/join.html',

  // いつか帳プラス（App Store Connect のサブスクリプションの製品ID）
  products: { monthly: 'itsuka.plus.monthly', yearly: 'itsuka.plus.yearly' },

  // ストアの規約・ポリシー（サブスクリプションの画面に必須）
  termsUrl: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
  privacyUrl: 'https://akiogita4383-prog.github.io/i-app_itsuka/privacy.html',

  // アフィリエイト。空のものは付けない（全部空なら設定画面にも出さない）
  affiliate: {
    amazonTag: '',          // 例: itsuka-22（Amazon アソシエイトのトラッキングID）
    rakutenId: '',          // 楽天アフィリエイトID（例: 1a2b3c4d.5e6f7a8b.1a2b3c4d.5e6f7a8b）
    valuecommerceSid: '',   // Yahoo!ショッピング（バリューコマース）の sid
    valuecommercePid: '',   // 同 pid
  },
};
