// アプリアイコン（1024px）とスプラッシュ（ライト/ダーク）を作る。
// 新しい意匠：クリーム地に白いノート、中央にチェック、右に5色のインデックスタブ（欲しい・観たい・行きたい・食べたい・作りたい）
//   npm run assets
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';

const TABS = [
  ['#F2545B', '欲しい', 'WANT'], ['#F5934A', '観たい', 'WATCH'], ['#3DBE7A', '行きたい', 'GO'],
  ['#3FA2EA', '食べたい', 'EAT'], ['#F2C230', '作りたい', 'MAKE'],
];
const FONT = `'Hiragino Maru Gothic ProN','Hiragino Sans','Zen Maru Gothic',sans-serif`;

// 1024 × 1024 の座標で描く
function mark({ labels = true } = {}) {
  const tabX = 640, tabW = 190, tabH = 118, top = 236;
  const tabs = TABS.map(([c, ja, en], i) => {
    const y = top + i * (tabH + 6);
    return `
    <g filter="url(#tabShadow)">
      <rect x="${tabX - 40}" y="${y}" width="${tabW + 40}" height="${tabH}" rx="26" fill="url(#g${i})"/>
    </g>
    ${labels ? `<text x="${tabX + tabW / 2 - 4}" y="${y + 62}" font-family="${FONT}" font-size="38" font-weight="700" fill="#fff" text-anchor="middle">${ja}</text>
    <text x="${tabX + tabW / 2 - 4}" y="${y + 96}" font-family="${FONT}" font-size="22" font-weight="600" fill="#fff" fill-opacity=".85" text-anchor="middle" letter-spacing="2">${en}</text>` : ''}`;
  }).join('');
  const lines = Array.from({ length: 11 }, (_, i) =>
    `<line x1="300" x2="610" y1="${270 + i * 54}" y2="${270 + i * 54}" stroke="#D9D6D1" stroke-width="5" stroke-linecap="round"/>`).join('');
  return `
  <defs>
    ${TABS.map(([c], i) => `<linearGradient id="g${i}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c}" stop-opacity=".78"/><stop offset=".35" stop-color="${c}"/><stop offset="1" stop-color="${c}"/></linearGradient>`).join('')}
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F1EFEC"/></linearGradient>
    <filter id="tabShadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#6B4A1E" flood-opacity=".22"/></filter>
    <filter id="bookShadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#6B4A1E" flood-opacity=".25"/></filter>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  </defs>
  ${tabs}
  <g filter="url(#bookShadow)">
    <path d="M300 200 H610 a40 40 0 0 1 40 40 V800 a40 40 0 0 1 -40 40 H300 Q190 840 190 730 V310 Q190 200 300 200 Z" fill="url(#paper)"/>
  </g>
  <line x1="262" y1="206" x2="262" y2="834" stroke="#DCD8D2" stroke-width="4"/>
  <rect x="214" y="470" width="20" height="100" rx="10" fill="#5E5A55"/>
  ${lines}
  <path d="M368 528 L446 606 L572 456" fill="none" stroke="#FFFFFF" stroke-width="58" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" opacity=".95"/>
  <path d="M368 528 L446 606 L572 456" fill="none" stroke="#BDBAB5" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M368 528 L446 606 L572 456" fill="none" stroke="#E9E7E3" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const bg = (a, b) => `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${bg('#FDF8F0', '#F3E6D2')}<rect width="1024" height="1024" fill="url(#bg)"/>${mark()}</svg>`;

// スプラッシュは 2732px 正方形の中央に小さく置く（LaunchScreen が aspectFill で表示）
const splash = (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732">
  ${bg(a, b)}<rect width="2732" height="2732" fill="url(#bg)"/>
  <g transform="translate(1110 1110) scale(.5)">${mark({ labels: false })}</g></svg>`;

const ICON_DIR = 'ios/App/App/Assets.xcassets/AppIcon.appiconset';
const SPLASH_DIR = 'ios/App/App/Assets.xcassets/Splash.imageset';
mkdirSync('store', { recursive: true });

await sharp(Buffer.from(icon)).flatten({ background: '#F7EEE0' }).png().toFile(`${ICON_DIR}/AppIcon-512@2x.png`);
await sharp(Buffer.from(icon)).flatten({ background: '#F7EEE0' }).png().toFile('store/icon-1024.png');
// Web版のアイコンも同じ意匠にそろえる
await sharp(Buffer.from(icon)).resize(512).png().toFile('www/icons/icon-512.png');
await sharp(Buffer.from(icon)).resize(192).png().toFile('www/icons/icon-192.png');
await sharp(Buffer.from(icon)).resize(180).png().toFile('www/icons/apple-touch-icon.png');
await sharp(Buffer.from(icon.replace('<g', '<g transform="translate(102 102) scale(.8)"><g').replace('</svg>', '</g></svg>')))
  .resize(512).png().toFile('www/icons/icon-maskable-512.png');

for (const [name, a, b] of [['splash', '#FBF8F3', '#F7F1E8'], ['splash-dark', '#221E1A', '#1C1915']]) {
  const png = sharp(Buffer.from(splash(a, b))).png();
  for (const s of ['', '-1', '-2']) await png.clone().toFile(`${SPLASH_DIR}/${name}-2732x2732${s}.png`);
}

writeFileSync(`${SPLASH_DIR}/Contents.json`, JSON.stringify({
  images: ['1x', '2x', '3x'].flatMap((scale, i) => {
    const s = ['', '-1', '-2'][i];
    return [
      { idiom: 'universal', filename: `splash-2732x2732${s}.png`, scale },
      { idiom: 'universal', filename: `splash-dark-2732x2732${s}.png`, scale,
        appearances: [{ appearance: 'luminosity', value: 'dark' }] },
    ];
  }),
  info: { version: 1, author: 'xcode' },
}, null, 2) + '\n');
console.log('icon & splash written');
