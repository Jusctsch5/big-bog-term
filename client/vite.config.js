import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/hosts": "http://127.0.0.1:3001",
      "/commands": "http://127.0.0.1:3001",
      "/terminal": {
        target: "ws://127.0.0.1:3001",
        ws: true,
      },
    },
  },
});