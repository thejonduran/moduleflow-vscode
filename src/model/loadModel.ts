import * as path from "node:path";
import * as vscode from "vscode";
import { parseExports, parseLocalFunctions } from "../analyzer/parseExports";
import { parseNamedImports } from "../analyzer/parseImports";
import { buildDefaultRegion, hasRegion, upsertRegion } from "../codegen/generateRegion";
import { upsertImports } from "../codegen/updateImports";
import { createInitialModel, createModelFromSource } from "../graph/jsToGraph";
import { ImportedToolModule, ModuleFlowModel } from "../types";

export const localModulePath = "moduleflow:local";

export async function readText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

export async function writeText(uri: vscode.Uri, source: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(source, "utf8"));
}

export function toModulePath(fromFile: vscode.Uri, importedFile: vscode.Uri): string {
  const fromDir = path.dirname(fromFile.fsPath);
  let relative = path.relative(fromDir, importedFile.fsPath).replace(/\\/g, "/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
}

export function resolveModuleUri(fromFile: vscode.Uri, modulePath: string): vscode.Uri {
  const fromDir = path.dirname(fromFile.fsPath);
  let resolved = path.resolve(fromDir, modulePath);
  if (!path.extname(resolved)) {
    resolved += ".js";
  }
  return vscode.Uri.file(resolved);
}

export async function readImportedToolModules(targetUri: vscode.Uri, source: string): Promise<ImportedToolModule[]> {
  const modules: ImportedToolModule[] = [];

  for (const namedImport of parseNamedImports(source)) {
    if (!namedImport.modulePath.startsWith(".")) {
      continue;
    }

    try {
      const importedUri = resolveModuleUri(targetUri, namedImport.modulePath);
      const importedSource = await readText(importedUri);
      const allExports = parseExports(importedSource);
      const selectedExports = allExports.flatMap((item) => {
        const importName = namedImport.names.find((name) => name.imported === item.name);
        return importName ? [{ ...item, callName: importName.local }] : [];
      });
      if (selectedExports.length === 0) {
        continue;
      }

      modules.push({
        fileName: path.basename(importedUri.fsPath),
        modulePath: namedImport.modulePath,
        exports: selectedExports
      });
    } catch {
      continue;
    }
  }

  return modules;
}

export function readLocalToolModule(targetUri: vscode.Uri, source: string): ImportedToolModule | undefined {
  const exports = parseLocalFunctions(source);
  if (exports.length === 0) {
    return undefined;
  }

  return {
    fileName: `${path.basename(targetUri.fsPath)} local`,
    modulePath: localModulePath,
    exports
  };
}

export async function loadModelFromFile(targetUri: vscode.Uri): Promise<ModuleFlowModel> {
  try {
    const source = await readText(targetUri);
    const imports = await readImportedToolModules(targetUri, source);
    const localTools = readLocalToolModule(targetUri, source);
    if (localTools) {
      imports.push(localTools);
    }
    return createModelFromSource(targetUri.fsPath, source, imports);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`ModuleFlow opened with a basic graph because parsing failed: ${messageText}`);
    return createInitialModel(targetUri.fsPath);
  }
}

export async function importTools(targetUri: vscode.Uri): Promise<ImportedToolModule[]> {
  const selected = await vscode.window.showOpenDialog({
    title: "Select JavaScript modules to import as ModuleFlow tools",
    defaultUri: vscode.Uri.file(path.dirname(targetUri.fsPath)),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    filters: {
      "JavaScript files": ["js", "mjs"]
    }
  });

  if (!selected?.length) {
    return [];
  }

  const modules: ImportedToolModule[] = [];
  for (const uri of selected) {
    const source = await readText(uri);
    const exports = parseExports(source);
    if (exports.length === 0) {
      continue;
    }

    modules.push({
      fileName: path.basename(uri.fsPath),
      modulePath: toModulePath(targetUri, uri),
      exports
    });
  }

  const targetSource = await readText(targetUri);
  const withImports = upsertImports(targetSource, modules);
  const functionName = vscode.workspace
    .getConfiguration("moduleflow")
    .get<string>("generatedFunctionName", "main");
  const withRegion = hasRegion(withImports) ? withImports : upsertRegion(withImports, buildDefaultRegion(functionName));
  await writeText(targetUri, withRegion);

  return modules;
}
