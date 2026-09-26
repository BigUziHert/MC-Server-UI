import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/data/**",
        "**/release/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/.dev-*.log",
      ],
    },
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
});
