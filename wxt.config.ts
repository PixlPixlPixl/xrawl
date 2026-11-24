import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Xrawl',
    description: 'Word discovery debugger for the Xrawl world engine.',
    permissions: ['storage'],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
});
