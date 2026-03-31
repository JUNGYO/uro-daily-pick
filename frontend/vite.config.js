import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/uro-daily-pick/",
  server: { port: 3000 },
});
