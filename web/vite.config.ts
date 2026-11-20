import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/@lezer')) {
            return 'vendor-codemirror';
          }
          if (id.includes('node_modules/pdfjs-dist')) {
            return 'vendor-pdfjs';
          }
          if (id.includes('node_modules/katex')) {
            return 'vendor-katex';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
