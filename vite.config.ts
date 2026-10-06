import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          step1: path.resolve(__dirname, 'step1.html'),
          step2: path.resolve(__dirname, 'step2.html'),
          step3: path.resolve(__dirname, 'step3.html'),
          step4: path.resolve(__dirname, 'step4.html'),
          step5: path.resolve(__dirname, 'step5.html'),
          step5Backup: path.resolve(__dirname, 'step5-with-paystack-BACKUP.html'),
          adminLogin: path.resolve(__dirname, 'admin-login.html'),
          adminDashboard: path.resolve(__dirname, 'admin-dashboard.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
