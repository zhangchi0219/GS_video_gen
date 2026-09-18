import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相对路径：M6 要部署到 BT Panel 的子目录，默认的 '/' 会让所有资源 404。
  // 注意这只改 Vite 自己生成的 URL；代码里拼出来的路径必须自己加 import.meta.env.BASE_URL。
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // three 和 spark 都是大件，拆开让浏览器能分别缓存。
        // Vite 8 的类型只接受函数形式，对象形式会报 ManualChunksFunction 不匹配。
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/@sparkjsdev')) return 'spark';
          return undefined;
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
});
