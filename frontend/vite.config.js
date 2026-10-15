import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function nonBlockingStylesheetPlugin() {
  return {
    name: "non-blocking-stylesheet",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        // Keep the small storefront-critical styles inline in index.html and
        // let the full, route-wide stylesheet download without blocking HTML paint.
        return html.replace(
          /<link rel="stylesheet" crossorigin href="([^"]+\.css)">/g,
          '<link rel="preload" as="style" href="$1" onload="this.onload=null;this.rel=\'stylesheet\'"><noscript><link rel="stylesheet" href="$1"></noscript>'
        );
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), nonBlockingStylesheetPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        secure: false
      }
    }
  }
});
