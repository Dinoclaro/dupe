import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

function copyPdfJsAssets() {
  const srcDir = path.resolve(__dirname, 'node_modules/pdfjs-dist/build');
  const outDir = path.resolve(__dirname, 'media/pdfjs');
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing pdfjs-dist asset: ${src}`);
    }
    fs.copyFileSync(src, path.join(outDir, file));
  }
}

async function main() {
  copyPdfJsAssets();
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
