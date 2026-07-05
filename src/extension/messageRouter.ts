import * as vscode from "vscode";
import { createInitialModel } from "../graph/jsToGraph";
import { importTools, loadModelFromFile } from "../model/loadModel";
import {
  addNode,
  addFunction,
  addCodeNode,
  deleteEdge,
  deleteFunction,
  deleteNode,
  duplicateNode,
  mapInput,
  renameVariable,
  renameFunction,
  setInputExpression,
  setReturnSource,
  updateDescription,
  updateControlFlow,
  updateCode,
  updatePosition
} from "../model/mutations";
import { ModuleFlowModel } from "../types";
import { renderHtml } from "../webview/renderHtml";

export type MessageRouterContext = {
  key: string;
  targetUri: vscode.Uri;
  panel: vscode.WebviewPanel;
  scriptUri: vscode.Uri;
  styleUri: vscode.Uri;
  models: Map<string, ModuleFlowModel>;
};

type WebviewMessage = {
  type?: string;
  [key: string]: unknown;
};

function currentModel(context: MessageRouterContext): ModuleFlowModel {
  return context.models.get(context.key) ?? createInitialModel(context.targetUri.fsPath);
}

function rerender(context: MessageRouterContext, model: ModuleFlowModel): void {
  context.panel.webview.html = renderHtml(model, context.scriptUri, context.styleUri);
}

async function publishModel(context: MessageRouterContext, model: ModuleFlowModel): Promise<void> {
  const delivered = await context.panel.webview.postMessage({
    type: "modelUpdated",
    model
  });

  if (!delivered) {
    rerender(context, model);
  }
}

export async function handleWebviewMessage(context: MessageRouterContext, message: WebviewMessage): Promise<void> {
  try {
    if (message?.type === "importTools") {
      const imported = await importTools(context.targetUri);
      if (imported.length === 0) {
        void vscode.window.showInformationMessage("No supported exports were found.");
        return;
      }

      const current = await loadModelFromFile(context.targetUri);
      const knownPaths = new Set(current.imports.map((item) => item.modulePath));
      current.imports = [...current.imports, ...imported.filter((item) => !knownPaths.has(item.modulePath))];
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "refresh") {
      const current = await loadModelFromFile(context.targetUri);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "addNode") {
      const current = currentModel(context);
      await addNode(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "addFunction") {
      const current = currentModel(context);
      await addFunction(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "addCodeNode") {
      const current = currentModel(context);
      await addCodeNode(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "mapInput") {
      const current = currentModel(context);
      await mapInput(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      return;
    }

    if (message?.type === "setReturn") {
      const current = currentModel(context);
      await setReturnSource(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      return;
    }

    if (message?.type === "updatePosition") {
      const current = currentModel(context);
      await updatePosition(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      return;
    }

    if (message?.type === "updateControlFlow") {
      const current = currentModel(context);
      await updateControlFlow(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "updateDescription") {
      const current = currentModel(context);
      await updateDescription(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      return;
    }

    if (message?.type === "updateCode") {
      const current = currentModel(context);
      await updateCode(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      return;
    }

    if (message?.type === "deleteNode") {
      const current = currentModel(context);
      await deleteNode(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "deleteFunction") {
      const current = currentModel(context);
      await deleteFunction(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "duplicateNode") {
      const current = currentModel(context);
      await duplicateNode(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "deleteEdge") {
      const current = currentModel(context);
      await deleteEdge(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      await publishModel(context, current);
      return;
    }

    if (message?.type === "renameVariable") {
      const current = currentModel(context);
      await renameVariable(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      return;
    }

    if (message?.type === "renameFunction") {
      const current = currentModel(context);
      await renameFunction(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      return;
    }

    if (message?.type === "setInputExpression") {
      const current = currentModel(context);
      await setInputExpression(context.targetUri, current, message as never);
      context.models.set(context.key, current);
      return;
    }

  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`ModuleFlow failed: ${messageText}`);
  }
}
