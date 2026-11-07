// GitHub Pages 用の一式を dist-web/ に作る。
// www/（アプリと共通）に、Web版専用の sw.js・manifest と、ストア提出用のサポート/プライバシーページを足す。
import { cpSync, rmSync, mkdirSync } from 'node:fs';
rmSync('dist-web', { recursive: true, force: true });
mkdirSync('dist-web');
cpSync('www', 'dist-web', { recursive: true });
cpSync('web', 'dist-web', { recursive: true });
console.log('dist-web/ ready — push its contents to GitHub Pages');
