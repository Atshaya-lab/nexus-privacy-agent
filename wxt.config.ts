import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Nexus Privacy Agent',
    version: '1.0.0',
    description: 'Privacy-first browser automation agent',
    permissions: ['activeTab', 'scripting', 'storage', 'debugger'],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://* http://127.0.0.1:* http://localhost:* data: blob:;",
    },
  },
});
