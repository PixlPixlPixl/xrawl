import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  // Static assets (the ONNX Runtime WASM binaries) live under src so they are
  // covered by the same TypeScript project and copied into every build.
  publicDir: 'src/public',
  manifest: ({ command }) => ({
    name: 'Xrawl',
    description: 'Word discovery debugger for the Xrawl world engine.',
    // `unlimitedStorage` asks for a quota exemption so IndexedDB history is not
    // evicted under storage pressure. It cannot protect against the user
    // removing the extension, which is what export/import is for.
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: [
      'http://*/*',
      'https://*/*',
      // Model weights are fetched once, then cached by the browser.
      'https://huggingface.co/*',
      'https://*.hf.co/*',
    ],
    // MV3 refuses to compile WebAssembly without an explicit allowance, and
    // refuses to evaluate scripts that are not part of the extension. ONNX
    // Runtime Web needs the first; shipping its binaries locally avoids the
    // second. Neither weakens isolation from page scripts.
    content_security_policy: {
      extension_pages:
        command === 'build'
          ? "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
          : "script-src 'self' 'wasm-unsafe-eval' http://localhost:*; object-src 'self'",
    },
  }),
});
