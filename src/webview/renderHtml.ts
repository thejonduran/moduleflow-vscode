import * as vscode from "vscode";
import { ModuleFlowModel } from "../types";

function escapeScriptJson(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderHtml(model: ModuleFlowModel, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
  const data = escapeScriptJson(JSON.stringify(model));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ModuleFlow</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <script id="moduleflow-data" type="application/json">${data}</script>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
