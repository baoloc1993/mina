// Đóng gói miniapp-hello thành zip (manifest.json + index.html) → ../../assets/miniapp-hello.zip
const fs = require('fs');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');

const root = __dirname;
const files = {
  'manifest.json': strToU8(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')),
  'index.html': strToU8(fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')),
};
const out = path.join(root, '..', '..', 'assets', 'miniapp-hello.zip');
fs.writeFileSync(out, Buffer.from(zipSync(files)));
console.log('đã ghi', out);
