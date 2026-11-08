// バンドラを使わず index.html から直接読むライブラリを www/ に置く
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('www/vendor', { recursive: true });
copyFileSync('node_modules/@capacitor/core/dist/capacitor.js', 'www/capacitor.js');
copyFileSync('node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'www/vendor/supabase.js');
console.log('www/capacitor.js, www/vendor/supabase.js updated');
