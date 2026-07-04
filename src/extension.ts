import * as path from "node:path";
import * as vscode from "vscode";
import { handleWebviewMessage } from "./extension/messageRouter";
import { loadModelFromFile, importTools } from "./model/loadModel";
import { ModuleFlowModel } from "./types";
import { renderHtml } from "./webview/renderHtml";

const panels = new Map<string, vscode.WebviewPanel>();
const models = new Map<string, ModuleFlowModel>();

function getTargetUri(uri?: vscode.Uri): vscode.Uri | undefined {
  return uri ?? vscode.window.activeTextEditor?.document.uri;
}

function webviewAssetUris(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): { scriptUri: vscode.Uri; styleUri: vscode.Uri } {
  return {
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "webview.js")),
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "webview.css"))
  };
}

async function openModuleFlow(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const targetUri = getTargetUri(uri);
  if (!targetUri) {
    void vscode.window.showErrorMessage("Open a JavaScript file first.");
    return;
  }

  const key = targetUri.toString();
  const existing = panels.get(key);
  if (existing) {
    const model = await loadModelFromFile(targetUri);
    models.set(key, model);
    const { scriptUri, styleUri } = webviewAssetUris(context, existing);
    existing.webview.html = renderHtml(model, scriptUri, styleUri);
    existing.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const model = await loadModelFromFile(targetUri);
  models.set(key, model);

  const panel = vscode.window.createWebviewPanel(
    "moduleflow",
    `ModuleFlow: ${path.basename(targetUri.fsPath)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  const { scriptUri, styleUri } = webviewAssetUris(context, panel);

  panels.set(key, panel);
  panel.webview.html = renderHtml(model, scriptUri, styleUri);

  panel.webview.onDidReceiveMessage((message) =>
    handleWebviewMessage({
      key,
      targetUri,
      panel,
      scriptUri,
      styleUri,
      models
    }, message)
  );

  panel.onDidDispose(() => {
    panels.delete(key);
  });
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("moduleflow.openFile", (uri?: vscode.Uri) => openModuleFlow(context, uri)),
    vscode.commands.registerCommand("moduleflow.importTools", async (uri?: vscode.Uri) => {
      const targetUri = getTargetUri(uri);
      if (!targetUri) {
        void vscode.window.showErrorMessage("Open a JavaScript file first.");
        return;
      }
      await importTools(targetUri);
    }),
    vscode.commands.registerCommand("moduleflow.refresh", async (uri?: vscode.Uri) => {
      const targetUri = getTargetUri(uri);
      if (!targetUri) {
        void vscode.window.showErrorMessage("Open a JavaScript file first.");
        return;
      }

      const key = targetUri.toString();
      const model = await loadModelFromFile(targetUri);
      models.set(key, model);

      const panel = panels.get(key);
      if (panel) {
        const { scriptUri, styleUri } = webviewAssetUris(context, panel);
        panel.webview.html = renderHtml(model, scriptUri, styleUri);
      }
    })
  );
}

export function deactivate(): void {}
