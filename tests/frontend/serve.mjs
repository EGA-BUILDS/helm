// Isolated test harness using Vite already installed by Vitest. Never an app route.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const vitestRequire = createRequire(require.resolve("vitest/package.json"));
const { createServer } = await import(pathToFileURL(vitestRequire.resolve("vite")).href);
const server = await createServer({
  configFile: false,
  root: new URL(".", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 4173, strictPort: true, fs: { allow: [process.cwd()] } },
  define: {
    "process.env.NODE_ENV": JSON.stringify("development"),
    "process.env.NEXT_PUBLIC_HELM_T3_FIXTURES": JSON.stringify("true"),
  },
});
await server.listen();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await server.close(); process.exit(0); });
