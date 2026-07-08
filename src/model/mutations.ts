import * as vscode from "vscode";
import { buildRegion, upsertRegion } from "../codegen/generateRegion";
import { codeOutputs } from "../graph/codeOutputs";
import { discoverFlows } from "../graph/flowDiscovery";
import { ExportParameter, ModuleExport, ModuleFlowModel, ModuleFlowNode } from "../types";
import { loadModelFromFile, readText, writeText } from "./loadModel";

function toVariableName(raw: string): string {
  const base = raw.replace(/^[A-Z]/, (letter) => letter.toLowerCase()).replace(/[^\w$]/g, "");
  return base || "value";
}

function nextVariableName(model: ModuleFlowModel, base: string): string {
  const used = new Set(
    model.nodes
      .map((node) => ("variableName" in node ? node.variableName : undefined))
      .filter((name): name is string => Boolean(name))
  );

  for (const toolModule of model.imports) {
    for (const item of toolModule.exports) {
      used.add(item.name);
    }
  }

  if (!used.has(base)) {
    return base;
  }

  let index = 2;
  while (used.has(`${base}${index}`)) {
    index += 1;
  }
  return `${base}${index}`;
}

function nextFunctionName(model: ModuleFlowModel, base: string): string {
  const used = new Set(
    model.nodes
      .filter((node): node is Extract<ModuleFlowNode, { kind: "input" }> => node.kind === "input")
      .map((node) => node.functionName)
  );

  if (!used.has(base)) {
    return base;
  }

  let index = 2;
  while (used.has(`${base}${index}`)) {
    index += 1;
  }
  return `${base}${index}`;
}

function uniqueNodeId(model: ModuleFlowModel, prefix: string): string {
  const used = new Set(model.nodes.map((node) => node.id));

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    if (!used.has(id)) {
      return id;
    }
  }

  return `${prefix}-${Date.now()}-${model.nodes.length + 1}`;
}

function defaultInputMappings(params: { name: string }[]): Record<string, string> {
  return Object.fromEntries(params.map((param) => [param.name, `input.${param.name}`]));
}

function defaultDirectInputMappings(params: { name: string }[]): Record<string, string> {
  return Object.fromEntries(params.map((param) => [param.name, param.name]));
}

function inputParamsFor(node: Extract<ModuleFlowNode, { kind: "input" }>): ExportParameter[] {
  return node.params === undefined ? [{ name: "input", required: true }] : node.params;
}

function resultVariableBase(exportName: string): string {
  const withoutVerb = exportName.replace(/^(get|build|create|make|calculate)/, "");
  const normalized = withoutVerb || `${exportName}Result`;
  return toVariableName(normalized);
}

function findToolExport(model: ModuleFlowModel, modulePath: string, exportName: string): ModuleExport | undefined {
  return model.imports
    .find((item) => item.modulePath === modulePath)
    ?.exports.find((item) => item.name === exportName);
}

function findUniqueToolExport(model: ModuleFlowModel, exportName: string): { modulePath: string; toolExport: ModuleExport } | undefined {
  const matches = model.imports.flatMap((toolModule) =>
    toolModule.exports
      .filter((item) => item.name === exportName)
      .map((toolExport) => ({ modulePath: toolModule.modulePath, toolExport }))
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function updateReturn(model: ModuleFlowModel, returnNodeId: string, source: string): void {
  const returnNode = model.nodes.find((node) => node.id === returnNodeId);
  if (returnNode?.kind === "return") {
    returnNode.source = source;
  }
}

function setNodePosition(model: ModuleFlowModel, nodeId: string, position: { x: number; y: number }): void {
  const node = model.nodes.find((item) => item.id === nodeId);
  if (node) {
    node.position = position;
  }
}

function setNodeSize(model: ModuleFlowModel, nodeId: string, size: { width: number; height: number }): void {
  const node = model.nodes.find((item) => item.id === nodeId);
  if (node) {
    node.size = size;
  }
}

function hasVariable(node: ModuleFlowNode): node is Extract<ModuleFlowNode, { variableName: string }> {
  return "variableName" in node;
}

function hasInputMappings(node: ModuleFlowNode): node is Extract<ModuleFlowNode, { inputMappings: Record<string, string> }> {
  return "inputMappings" in node;
}

function sanitizeIdentifier(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}

function replaceSourceReferences(model: ModuleFlowModel, oldSource: string, newSource: string): void {
  for (const node of model.nodes) {
    if (hasInputMappings(node)) {
      for (const [inputName, source] of Object.entries(node.inputMappings)) {
        if (source === oldSource) {
          node.inputMappings[inputName] = newSource;
        }
      }
    }

  }

  for (const node of model.nodes) {
    if (node.kind === "return" && node.source === oldSource) {
      node.source = newSource;
    }
  }
}

function removeReferencesToSource(model: ModuleFlowModel, source: string): void {
  for (const node of model.nodes) {
    if (hasInputMappings(node)) {
      for (const [inputName, mappedSource] of Object.entries(node.inputMappings)) {
        if (mappedSource === source) {
          node.inputMappings[inputName] = `input.${inputName}`;
        }
      }
    }

  }

  for (const node of model.nodes) {
    if (node.kind === "return" && node.source === source) {
      node.source = "input";
    }
  }
}

function outputSourcesForNode(node: ModuleFlowNode): string[] {
  if (hasVariable(node)) {
    return [node.variableName];
  }

  if (node.kind === "code") {
    return codeOutputs(node.code);
  }

  return [];
}

function duplicateNodeId(model: ModuleFlowModel, node: ModuleFlowNode): string {
  const prefix = node.kind === "code" ? "code" : "node";
  return uniqueNodeId(model, prefix);
}

function offsetPosition(position: { x: number; y: number } | undefined): { x: number; y: number } | undefined {
  return position
    ? {
        x: position.x + 36,
        y: position.y + 36
      }
    : undefined;
}

export async function persistModel(targetUri: vscode.Uri, model: ModuleFlowModel): Promise<void> {
  const functionName = vscode.workspace
    .getConfiguration("moduleflow")
    .get<string>("generatedFunctionName", "main");
  const source = await readText(targetUri);
  await writeText(targetUri, upsertRegion(source, buildRegion(functionName, model.nodes, model.controlFlow)));
}

function createsControlCycle(controlFlow: { from: string; to: string }[], from: string, to: string): boolean {
  const nextByFrom = new Map(controlFlow.map((edge) => [edge.from, edge.to]));
  const seen = new Set<string>([from]);
  let current = to;

  while (current) {
    if (seen.has(current)) {
      return true;
    }
    seen.add(current);
    const next = nextByFrom.get(current);
    if (!next) {
      return false;
    }
    current = next;
  }

  return false;
}

export async function updateControlFlow(targetUri: vscode.Uri, model: ModuleFlowModel, message: { from: string; to: string }): Promise<void> {
  if (message.from === message.to) {
    return;
  }

  const nodeIds = new Set(model.nodes.map((node) => node.id));
  if (!nodeIds.has(message.from) || !nodeIds.has(message.to)) {
    return;
  }

  const nextControlFlow = model.controlFlow.filter((edge) => edge.from !== message.from && edge.to !== message.to);
  nextControlFlow.push({ from: message.from, to: message.to });
  if (createsControlCycle(nextControlFlow, message.from, message.to)) {
    void vscode.window.showErrorMessage("ModuleFlow control flow cannot contain cycles.");
    return;
  }

  const discovery = discoverFlows(model.nodes, nextControlFlow);
  if (discovery.flows.some((flow) => flow.errors.includes("shared-node"))) {
    void vscode.window.showErrorMessage("ModuleFlow nodes can only belong to one function flow.");
    return;
  }

  model.controlFlow = nextControlFlow;
  await persistModel(targetUri, model);
}

export async function deleteControlFlowEdge(targetUri: vscode.Uri, model: ModuleFlowModel, message: { from: string; to: string }): Promise<void> {
  model.controlFlow = model.controlFlow.filter((edge) => !(edge.from === message.from && edge.to === message.to));
  await persistModel(targetUri, model);
}

export async function addNode(targetUri: vscode.Uri, model: ModuleFlowModel, message: { modulePath: string; exportName: string; methodName?: string | null; position?: { x: number; y: number } }): Promise<void> {
  let toolExport = findToolExport(model, message.modulePath, message.exportName);
  let modulePath = message.modulePath;
  if (!toolExport) {
    const latestModel = await loadModelFromFile(targetUri);
    model.imports = latestModel.imports;
    toolExport = findToolExport(model, message.modulePath, message.exportName);
    if (!toolExport) {
      const uniqueMatch = findUniqueToolExport(model, message.exportName);
      if (uniqueMatch) {
        modulePath = uniqueMatch.modulePath;
        toolExport = uniqueMatch.toolExport;
      }
    }
  }

  if (!toolExport) {
    const availableExports = model.imports
      .map((toolModule) => `${toolModule.modulePath}: ${toolModule.exports.map((item) => item.name).join(", ")}`)
      .join("; ");
    void vscode.window.showErrorMessage(
      `ModuleFlow could not find ${message.exportName} from ${message.modulePath}. Available tools: ${availableExports || "none"}.`
    );
    return;
  }

  if (message.methodName) {
    const method = toolExport.methods.find((item) => item.name === message.methodName);
    const instanceNode = model.nodes.find(
      (node): node is Extract<ModuleFlowNode, { kind: "classInstance" }> =>
        node.kind === "classInstance" && node.exportName === toolExport.name
    );

    if (!method || !instanceNode) {
      void vscode.window.showInformationMessage(`Add a ${toolExport.name} instance before adding ${message.methodName}().`);
      return;
    }

    const variableName = nextVariableName(model, toVariableName(method.name === "get" ? "result" : method.name));
    model.nodes.splice(model.nodes.length - 1, 0, {
      id: uniqueNodeId(model, "node"),
      kind: "methodCall",
      label: `${instanceNode.variableName}.${method.name}`,
      instanceVariableName: instanceNode.variableName,
      methodName: method.name,
      params: method.params,
      inputMappings: defaultInputMappings(method.params),
      variableName,
      async: method.async,
      position: message.position
    });
    await persistModel(targetUri, model);
    return;
  }

  if (toolExport.kind === "class") {
    const variableName = nextVariableName(model, toVariableName(toolExport.name));
    model.nodes.splice(model.nodes.length - 1, 0, {
      id: uniqueNodeId(model, "node"),
      kind: "classInstance",
      label: `new ${toolExport.name}`,
      modulePath,
      exportName: toolExport.name,
      callName: toolExport.callName,
      params: toolExport.params,
      inputMappings: defaultInputMappings(toolExport.params),
      variableName,
      position: message.position
    });
    await persistModel(targetUri, model);
    return;
  }

  const variableName = nextVariableName(model, resultVariableBase(toolExport.name));
  model.nodes.splice(model.nodes.length - 1, 0, {
    id: uniqueNodeId(model, "node"),
    kind: "call",
    label: toolExport.name,
    modulePath,
    exportName: toolExport.name,
    callName: toolExport.callName,
    params: toolExport.params,
    inputMappings: defaultInputMappings(toolExport.params),
    variableName,
    async: toolExport.async,
    position: message.position
  });
  await persistModel(targetUri, model);
}

export async function addModuleFlowCall(
  targetUri: vscode.Uri,
  model: ModuleFlowModel,
  message: { functionNodeId: string; position?: { x: number; y: number } }
): Promise<void> {
  const inputNode = model.nodes.find((node): node is Extract<ModuleFlowNode, { kind: "input" }> =>
    node.kind === "input" && node.id === message.functionNodeId
  );
  if (!inputNode) {
    return;
  }

  model.nodes.splice(model.nodes.length - 1, 0, {
    id: uniqueNodeId(model, "node"),
    kind: "moduleFlowCall",
    label: inputNode.functionName,
    functionNodeId: inputNode.id,
    inputMappings: defaultDirectInputMappings(inputParamsFor(inputNode)),
    variableName: nextVariableName(model, resultVariableBase(inputNode.functionName)),
    position: message.position
  });
  await persistModel(targetUri, model);
}

export async function addFunction(targetUri: vscode.Uri, model: ModuleFlowModel, message: { position?: { x: number; y: number } }): Promise<void> {
  const functionName = nextFunctionName(model, "main");
  const inputId = uniqueNodeId(model, "input");
  const returnId = uniqueNodeId(model, "return");
  const position = message.position ?? { x: 80, y: 120 + model.nodes.length * 40 };

  model.nodes.push(
    {
      id: inputId,
      kind: "input",
      label: "input",
      functionName,
      params: [{ name: "input", required: true }],
      position
    },
    {
      id: returnId,
      kind: "return",
      label: "return",
      source: "input",
      position: {
        x: position.x + 540,
        y: position.y
      }
    }
  );
  model.controlFlow.push({ from: inputId, to: returnId });
  await persistModel(targetUri, model);
}

export async function addCodeNode(targetUri: vscode.Uri, model: ModuleFlowModel, message: { position?: { x: number; y: number } }): Promise<void> {
  model.nodes.push({
    id: uniqueNodeId(model, "code"),
    kind: "code",
    label: "code",
    code: "// write code here",
    position: message.position
  });
  await persistModel(targetUri, model);
}

export async function addMarkdownNode(targetUri: vscode.Uri, model: ModuleFlowModel, message: { position?: { x: number; y: number } }): Promise<void> {
  model.nodes.push({
    id: uniqueNodeId(model, "markdown"),
    kind: "markdown",
    label: "markdown",
    markdown: "",
    position: message.position,
    size: {
      width: 350,
      height: 200
    }
  });
  await persistModel(targetUri, model);
}

export async function mapInput(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; paramName: string; source: string }): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  if (!node || !("inputMappings" in node)) {
    return;
  }

  node.inputMappings[message.paramName] = message.source;
  await persistModel(targetUri, model);
}

export async function setReturnSource(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; source: string }): Promise<void> {
  updateReturn(model, message.nodeId, message.source);
  await persistModel(targetUri, model);
}

export async function updatePosition(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; position: { x: number; y: number } }): Promise<void> {
  setNodePosition(model, message.nodeId, message.position);
  await persistModel(targetUri, model);
}

export async function updatePositions(
  targetUri: vscode.Uri,
  model: ModuleFlowModel,
  message: { positions: { nodeId: string; position: { x: number; y: number } }[] }
): Promise<void> {
  for (const item of message.positions) {
    setNodePosition(model, item.nodeId, item.position);
  }

  await persistModel(targetUri, model);
}

function updateExactSourceReference(model: ModuleFlowModel, oldSource: string, newSource: string, nodeIds: Set<string>): void {
  for (const node of model.nodes) {
    if (!nodeIds.has(node.id)) {
      continue;
    }

    if (hasInputMappings(node)) {
      for (const [inputName, source] of Object.entries(node.inputMappings)) {
        if (source === oldSource) {
          node.inputMappings[inputName] = newSource;
        }
      }
    }

    if (node.kind === "return" && node.source === oldSource) {
      node.source = newSource;
    }
  }
}

export async function updateFunctionInputs(
  targetUri: vscode.Uri,
  model: ModuleFlowModel,
  message: { nodeId: string; params: ExportParameter[] }
): Promise<void> {
  const inputNode = model.nodes.find((item): item is Extract<ModuleFlowNode, { kind: "input" }> =>
    item.kind === "input" && item.id === message.nodeId
  );
  if (!inputNode) {
    return;
  }

  const params = message.params.map((param) => ({
    name: param.name.trim(),
    required: param.required,
    defaultValue: param.defaultValue
  }));
  const names = new Set<string>();
  if (params.some((param) => !sanitizeIdentifier(param.name) || names.has(param.name) || (names.add(param.name), false))) {
    void vscode.window.showErrorMessage("ModuleFlow function inputs must be unique valid JavaScript identifiers.");
    return;
  }

  const oldParams = inputParamsFor(inputNode);
  const flow = discoverFlows(model.nodes, model.controlFlow).flows.find((item) => item.input.id === inputNode.id);
  const flowNodeIds = new Set(flow?.nodes.map((node) => node.id) ?? []);

  oldParams.forEach((oldParam, index) => {
    const newParam = params[index];
    if (newParam && oldParam.name !== newParam.name) {
      updateExactSourceReference(model, oldParam.name, newParam.name, flowNodeIds);
      updateExactSourceReference(model, `input.${oldParam.name}`, newParam.name, flowNodeIds);
    } else if (!newParam) {
      updateExactSourceReference(model, oldParam.name, "undefined", flowNodeIds);
      updateExactSourceReference(model, `input.${oldParam.name}`, "undefined", flowNodeIds);
    }
  });

  for (const node of model.nodes) {
    if (node.kind !== "moduleFlowCall" || node.functionNodeId !== inputNode.id) {
      continue;
    }

    const previousMappings = node.inputMappings;
    node.inputMappings = Object.fromEntries(params.map((param, index) => {
      const oldParam = oldParams[index];
      return [param.name, previousMappings[param.name] ?? (oldParam ? previousMappings[oldParam.name] : undefined) ?? param.name];
    }));
  }

  inputNode.params = params;
  if (params.length > 0) {
    inputNode.execute = undefined;
  }
  await persistModel(targetUri, model);
}

export async function updateFunctionExecute(
  targetUri: vscode.Uri,
  model: ModuleFlowModel,
  message: { nodeId: string; execute: boolean }
): Promise<void> {
  const inputNode = model.nodes.find((item): item is Extract<ModuleFlowNode, { kind: "input" }> =>
    item.kind === "input" && item.id === message.nodeId
  );
  if (!inputNode) {
    return;
  }

  if (message.execute && inputParamsFor(inputNode).length > 0) {
    void vscode.window.showErrorMessage("Only functions with no inputs can be executed automatically.");
    return;
  }

  for (const node of model.nodes) {
    if (node.kind === "input") {
      node.execute = node.id === inputNode.id && message.execute ? true : undefined;
    }
  }

  await persistModel(targetUri, model);
}

export async function updateNodeSize(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; size: { width: number; height: number } }): Promise<void> {
  setNodeSize(model, message.nodeId, message.size);
  await persistModel(targetUri, model);
}

export async function updateDescription(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; description: string }): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  if (!node) {
    return;
  }

  const description = message.description.trim();
  node.description = description || undefined;
  await persistModel(targetUri, model);
}

export async function updateCode(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; code: string }): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  if (!node || node.kind !== "code") {
    return;
  }

  node.code = message.code;
  await persistModel(targetUri, model);
}

export async function updateMarkdown(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; markdown: string }): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  if (!node || node.kind !== "markdown") {
    return;
  }

  node.markdown = message.markdown;
  await persistModel(targetUri, model);
}

export async function deleteNode(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string }): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  if (!node || node.kind === "input" || node.kind === "return") {
    return;
  }

  const sourcesToRemove = new Set<string>();
  if (hasVariable(node)) {
    sourcesToRemove.add(node.variableName);
  }

  if (node.kind === "classInstance") {
    for (const child of model.nodes) {
      if (child.kind === "methodCall" && child.instanceVariableName === node.variableName) {
        sourcesToRemove.add(child.variableName);
      }
    }

    model.nodes = model.nodes.filter((item) => item.id !== node.id && !(item.kind === "methodCall" && item.instanceVariableName === node.variableName));
  } else {
    model.nodes = model.nodes.filter((item) => item.id !== node.id);
  }

  model.controlFlow = model.controlFlow.filter((edge) => edge.from !== node.id && edge.to !== node.id);

  for (const source of sourcesToRemove) {
    removeReferencesToSource(model, source);
  }

  await persistModel(targetUri, model);
}

export async function duplicateNode(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string }): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  if (!node || node.kind === "input" || node.kind === "return") {
    return;
  }

  const duplicatedNode = JSON.parse(JSON.stringify(node)) as ModuleFlowNode;
  duplicatedNode.id = duplicateNodeId(model, node);
  duplicatedNode.position = offsetPosition(node.position);

  if (hasVariable(duplicatedNode)) {
    duplicatedNode.variableName = nextVariableName(model, duplicatedNode.variableName);
  }

  model.nodes.push(duplicatedNode);
  await persistModel(targetUri, model);
}

export async function deleteFunction(targetUri: vscode.Uri, model: ModuleFlowModel, message: { inputNodeId: string }): Promise<void> {
  const flow = discoverFlows(model.nodes, model.controlFlow).flows.find((item) => item.input.id === message.inputNodeId);
  if (!flow) {
    return;
  }

  const nodeCount = flow.nodes.length;
  const confirmed = await vscode.window.showWarningMessage(
    `Delete function "${flow.input.functionName}" and ${nodeCount} node${nodeCount === 1 ? "" : "s"} in its flow?`,
    { modal: true },
    "Delete function"
  );
  if (confirmed !== "Delete function") {
    return;
  }

  const deletedNodeIds = new Set(flow.nodes.map((node) => node.id));
  const sourcesToRemove = new Set(flow.nodes.flatMap(outputSourcesForNode));

  model.nodes = model.nodes.filter((node) => !deletedNodeIds.has(node.id));
  model.controlFlow = model.controlFlow.filter((edge) => !deletedNodeIds.has(edge.from) && !deletedNodeIds.has(edge.to));

  for (const source of sourcesToRemove) {
    removeReferencesToSource(model, source);
  }

  await persistModel(targetUri, model);
}

export async function deleteEdge(targetUri: vscode.Uri, model: ModuleFlowModel, message: { source?: string; target: string; targetHandle?: string | null }): Promise<void> {
  if (message.targetHandle === "control-in" && message.source) {
    await deleteControlFlowEdge(targetUri, model, { from: message.source, to: message.target });
    return;
  }

  const targetNode = model.nodes.find((node) => node.id === message.target);
  if (targetNode?.kind === "return") {
    updateReturn(model, targetNode.id, "input");
    await persistModel(targetUri, model);
    return;
  }

  const node = model.nodes.find((item) => item.id === message.target);
  if (!node || !hasInputMappings(node) || !message.targetHandle) {
    return;
  }

  node.inputMappings[message.targetHandle] = `input.${message.targetHandle}`;
  await persistModel(targetUri, model);
}

export async function renameVariable(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; variableName: string }): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  if (!node || !hasVariable(node)) {
    return;
  }

  const nextName = sanitizeIdentifier(message.variableName);
  if (!nextName) {
    void vscode.window.showErrorMessage("ModuleFlow variable names must be valid JavaScript identifiers.");
    return;
  }

  const oldName = node.variableName;
  if (oldName === nextName) {
    return;
  }

  node.variableName = nextName;
  replaceSourceReferences(model, oldName, nextName);

  if (node.kind === "classInstance") {
    for (const child of model.nodes) {
      if (child.kind === "methodCall" && child.instanceVariableName === oldName) {
        child.instanceVariableName = nextName;
        child.label = `${nextName}.${child.methodName}`;
      }
    }
  }

  await persistModel(targetUri, model);
}

export async function renameFunction(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; functionName: string }): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  if (!node || node.kind !== "input") {
    return;
  }

  const nextName = sanitizeIdentifier(message.functionName);
  if (!nextName) {
    void vscode.window.showErrorMessage("ModuleFlow function names must be valid JavaScript identifiers.");
    return;
  }

  if (node.functionName === nextName) {
    return;
  }

  const duplicate = model.nodes.some((item) => item.kind === "input" && item.id !== node.id && item.functionName === nextName);
  if (duplicate) {
    void vscode.window.showErrorMessage("ModuleFlow function names must be unique in the file.");
    return;
  }

  node.functionName = nextName;
  await persistModel(targetUri, model);
}

export async function setInputExpression(targetUri: vscode.Uri, model: ModuleFlowModel, message: { nodeId: string; paramName: string; source: string }): Promise<void> {
  await mapInput(targetUri, model, message);
}

export async function setModuleFlowCallFunction(
  targetUri: vscode.Uri,
  model: ModuleFlowModel,
  message: { nodeId: string; functionNodeId: string }
): Promise<void> {
  const node = model.nodes.find((item) => item.id === message.nodeId);
  const inputNode = model.nodes.find((item): item is Extract<ModuleFlowNode, { kind: "input" }> =>
    item.kind === "input" && item.id === message.functionNodeId
  );
  if (!node || node.kind !== "moduleFlowCall" || !inputNode) {
    return;
  }

  node.functionNodeId = message.functionNodeId;
  node.label = inputNode.functionName;
  await persistModel(targetUri, model);
}
