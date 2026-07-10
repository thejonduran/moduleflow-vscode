const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function escapeScriptJson(value) {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const model = {
  targetFile: "preview/main.js",
  imports: [
    {
      fileName: "utils.js",
      modulePath: "./utils.js",
      exports: [
        {
          kind: "function",
          name: "calculateDistance",
          async: true,
          params: [
            { name: "origin", required: true },
            { name: "destination", required: true }
          ],
          methods: []
        },
        {
          kind: "function",
          name: "formatSummary",
          async: false,
          params: [
            { name: "user", required: true },
            { name: "distance", required: true }
          ],
          methods: []
        }
      ]
    }
  ],
  controlFlow: [
    { from: "input", to: "distance-node" },
    { from: "distance-node", to: "summary-node" },
    { from: "summary-node", to: "log-node" },
    { from: "log-node", to: "return" }
  ],
  nodes: [
    {
      id: "input",
      kind: "input",
      label: "input",
      functionName: "main",
      position: { x: 80, y: 180 }
    },
    {
      id: "distance-node",
      kind: "call",
      label: "calculateDistance",
      modulePath: "./utils.js",
      exportName: "calculateDistance",
      params: [
        { name: "origin", required: true },
        { name: "destination", required: true }
      ],
      inputMappings: {
        origin: "input.origin",
        destination: "input.destination"
      },
      variableName: "distance",
      async: true,
      position: { x: 640, y: 190 }
    },
    {
      id: "summary-node",
      kind: "call",
      label: "formatSummary",
      modulePath: "./utils.js",
      exportName: "formatSummary",
      params: [
        { name: "user", required: true },
        { name: "distance", required: true }
      ],
      inputMappings: {
        user: "input.user",
        distance: "distance"
      },
      variableName: "summary",
      async: false,
      position: { x: 940, y: 180 }
    },
    {
      id: "draft-node",
      kind: "call",
      label: "formatSummary",
      modulePath: "./utils.js",
      exportName: "formatSummary",
      params: [
        { name: "user", required: true },
        { name: "distance", required: true }
      ],
      inputMappings: {
        user: "input.draftUser",
        distance: "input.draftDistance"
      },
      variableName: "draft",
      async: false,
      position: { x: 940, y: 430 }
    },
    {
      id: "log-node",
      kind: "code",
      label: "code",
      code: "const debugSummary = summary;\nconsole.log(\"summary\", debugSummary);",
      position: { x: 1240, y: 180 }
    },
    {
      id: "return",
      kind: "return",
      label: "return",
      source: "summary",
      position: { x: 1540, y: 190 }
    }
  ]
};

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ModuleFlow Preview</title>
  <style>
    :root {
      --vscode-editor-background: #1e1e1e;
      --vscode-foreground: #cccccc;
      --vscode-descriptionForeground: #9d9d9d;
      --vscode-sideBar-background: #252526;
      --vscode-panel-border: #3c3c3c;
      --vscode-focusBorder: #007fd4;
      --vscode-input-background: #3c3c3c;
      --vscode-input-foreground: #cccccc;
      --vscode-input-border: #3c3c3c;
      --vscode-button-background: #0e639c;
      --vscode-button-foreground: #ffffff;
      --vscode-button-hoverBackground: #1177bb;
      --vscode-inputValidation-errorBackground: #5a1d1d;
      --vscode-inputValidation-errorBorder: #be1100;
      --vscode-inputValidation-warningBackground: #352a05;
      --vscode-inputValidation-warningBorder: #b89500;
      --vscode-inputValidation-warningForeground: #cccccc;
      --moduleflow-cardBorder: #565656;
      --moduleflow-cardBackground: #252526;
      --moduleflow-cardFooter: #202020;
      --moduleflow-dataEdge: #4aa3ff;
      --moduleflow-flowEdge: #d7a846;
    }
  </style>
  <link rel="stylesheet" href="./webview.css" />
</head>
<body>
  <script>
    window.acquireVsCodeApi = function () {
      return {
        postMessage(message) {
          console.log("[ModuleFlow preview postMessage]", message);
        }
      };
    };
  </script>
  <script id="moduleflow-data" type="application/json">${escapeScriptJson(JSON.stringify(model))}</script>
  <div id="root"></div>
  <script src="./webview.js?v=${Date.now()}"></script>
</body>
</html>
`;

const outfile = path.join(root, "media", "preview-webview.html");
fs.writeFileSync(outfile, html, "utf8");
console.log(`Preview written to ${outfile}`);
