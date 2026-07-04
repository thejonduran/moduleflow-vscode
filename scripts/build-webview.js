const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");

esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: [path.join(root, "src", "webview", "app.tsx")],
  bundle: true,
  format: "iife",
  globalName: "ModuleFlowWebview",
  outfile: path.join(root, "media", "webview.js"),
  sourcemap: true,
  logLevel: "info"
});
