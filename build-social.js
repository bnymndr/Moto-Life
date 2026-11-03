// Sosyal arayüzü (src/SocialProfile.jsx) tarayıcı paketine derler: npm run build:social
require('esbuild').build({
  entryPoints: ['src/social.entry.jsx'], bundle: true, minify: true, format: 'iife', jsx: 'automatic',
  outfile: 'public/social.bundle.js', define: { 'process.env.NODE_ENV': '"production"' }
}).then(() => console.log('public/social.bundle.js hazır')).catch(() => process.exit(1));
