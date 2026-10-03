import { defineConfig } from 'vite';
export default defineConfig({
  clearScreen: false,
  server: { watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: ['safari15', 'chrome105'] },
});
