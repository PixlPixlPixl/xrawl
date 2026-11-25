import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Xrawl',
    description: 'Word discovery debugger for the Xrawl world engine.',
    // `unlimitedStorage` asks for a quota exemption so IndexedDB history is not
    // evicted under storage pressure. It cannot protect against the user
    // removing the extension, which is what export/import is for.
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
});
