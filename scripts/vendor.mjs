// @capacitor/core の capacitor.js を www/ に置く（バンドラを使わず、index.html から直接読むため）
import { copyFileSync } from 'node:fs';
copyFileSync('node_modules/@capacitor/core/dist/capacitor.js', 'www/capacitor.js');
console.log('www/capacitor.js updated');
