// アプリアイコン（1024px）とスプラッシュ（ライト/ダーク）を作る。現行のインデックスタブ意匠を描き直したもの。
//   npm run assets
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const INK = '#1F2535';
const TABS = ['#F3C94B', '#7DB7F0', '#7FCB9B', '#F29E7A', '#B79AE8'];

// 512 基準で描いて、viewBox で拡大する
const mark = `
  ${TABS.map((c, i) => `<rect x="${82 + i * 72}" y="${i === 0 ? 90 : 108}" width="60" height="90" rx="12" fill="${c}"/>`).join('')}
  <rect x="72" y="157" width="368" height="261" rx="30" fill="#FFFFFF"/>
  ${[[230, 390], [300, 338], [370, 362]].map(([y, x2], i) => `
    <rect x="122" y="${y - 16}" width="20" height="32" rx="8" fill="${TABS[i === 0 ? 0 : i === 1 ? 1 : 2]}"/>
    <rect x="160" y="${y - 10}" width="${x2 - 160}" height="20" rx="10" fill="#D5DAE3"/>`).join('')}`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${INK}"/>${mark}</svg>`;

// スプラッシュは 2732px 正方形の中央に小さく置く（Capacitor の LaunchScreen が aspectFill で表示）
const splash = bg => `<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732">
  <rect width="2732" height="2732" fill="${bg}"/>
  <g transform="translate(1110 1110) scale(1)"><rect width="512" height="512" rx="112" fill="${INK}"/>${mark}</g></svg>`;

const ICON_DIR = 'ios/App/App/Assets.xcassets/AppIcon.appiconset';
const SPLASH_DIR = 'ios/App/App/Assets.xcassets/Splash.imageset';

await sharp(Buffer.from(icon)).flatten({ background: INK }).png().toFile(`${ICON_DIR}/AppIcon-512@2x.png`);
await sharp(Buffer.from(icon)).resize(1024).png().toFile('store/icon-1024.png');
for (const [name, bg] of [['splash', '#E9ECF1'], ['splash-dark', '#171B24']]) {
  const png = sharp(Buffer.from(splash(bg))).png();
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
