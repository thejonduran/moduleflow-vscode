import { ControlFlowEdge, ModuleFlowNode } from "../types";
import { discoverFlows } from "../graph/flowDiscovery";
import { assertWritableModuleFlowRegion, inspectModuleFlowRegion, startMarker, endMarker } from "./moduleFlowRegion";

function positionCommentFor(node: ModuleFlowNode): string | undefined {
  const metadataParts = [
    node.position ? `x:${Math.round(node.position.x)}` : undefined,
    node.position ? `y:${Math.round(node.position.y)}` : undefined,
    node.size ? `w:${Math.round(node.size.width)}` : undefined,
    node.size ? `h:${Math.round(node.size.height)}` : undefined,
    node.kind === "input" ? "kind:input" : undefined,
    node.kind === "return" ? "kind:return" : undefined,
    node.kind === "code" ? "kind:code" : undefined,
    node.kind === "markdown" ? "kind:markdown" : undefined,
    node.kind === "moduleFlowCall" ? "kind:moduleFlowCall" : undefined
  ].filter(Boolean);

  return metadataParts.length > 0
    ? `  // @moduleflow:node ${node.id} ${metadataParts.join(" ")}`
    : undefined;
}

function descriptionCommentFor(node: ModuleFlowNode): string | undefined {
  return node.description
    ? `  // @moduleflow:description ${node.id} ${JSON.stringify(node.description)}`
    : undefined;
}

function metadataCommentsFor(node: ModuleFlowNode): string {
  return [positionCommentFor(node), descriptionCommentFor(node)].filter(Boolean).join("\n");
}

function markdownCommentsFor(node: Extract<ModuleFlowNode, { kind: "markdown" }>): string | undefined {
  const metadataComments = metadataCommentsFor(node).replace(/^  /gm, "");
  const markdownComment = `// @moduleflow:markdown ${node.id} ${JSON.stringify(node.markdown)}`;
  return [metadataComments, markdownComment].filter(Boolean).join("\n");
}

function argsFor(
  params: { name: string; required: boolean; defaultValue?: string }[],
  inputMappings: Record<string, string> = {}
): string {
  return params.map((param) => inputMappings[param.name] ?? param.defaultValue ?? `input.${param.name}`).join(", ");
}

function moduleFlowFunctionName(nodes: ModuleFlowNode[], inputNodeId: string): string | undefined {
  return nodes.find((node): node is Extract<ModuleFlowNode, { kind: "input" }> =>
    node.kind === "input" && node.id === inputNodeId
  )?.functionName;
}

function statementFor(node: ModuleFlowNode, nodes: ModuleFlowNode[]): string | undefined {
  const metadataComments = metadataCommentsFor(node);
  const prefix = metadataComments ? `${metadataComments}\n` : "";

  if (node.kind === "code") {
    const indentedCode = node.code
      .split(/\r?\n/)
      .map((line) => line.trim() ? `  ${line}` : "")
      .join("\n");
    return `${prefix}${indentedCode}\n  // @moduleflow:node:end ${node.id}`;
  }

  if (node.kind === "classInstance") {
    return `${prefix}  const ${node.variableName} = new ${node.callName ?? node.exportName}(${argsFor(node.params, node.inputMappings)});`;
  }

  if (node.kind === "call") {
    const awaitPrefix = node.async ? "await " : "";
    return `${prefix}  const ${node.variableName} = ${awaitPrefix}${node.callName ?? node.exportName}(${argsFor(node.params, node.inputMappings)});`;
  }

  if (node.kind === "moduleFlowCall") {
    const functionName = moduleFlowFunctionName(nodes, node.functionNodeId);
    if (!functionName) {
      return undefined;
    }
    return `${prefix}  const ${node.variableName} = await ${functionName}(${node.inputMappings.input ?? "input"});`;
  }

  if (node.kind === "methodCall") {
    const awaitPrefix = node.async ? "await " : "";
    return `${prefix}  const ${node.variableName} = ${awaitPrefix}${node.instanceVariableName}.${node.methodName}(${argsFor(node.params, node.inputMappings)});`;
  }

  return undefined;
}

export function buildDefaultRegion(functionName: string): string {
  return [
    startMarker,
    `export async function ${functionName}(input) {`,
    "  return input;",
    "}",
    endMarker
  ].join("\n");
}

export function hasRegion(source: string): boolean {
  const inspection = inspectModuleFlowRegion(source);
  return inspection.ok && inspection.hasRegion;
}

function buildFunction(flow: ReturnType<typeof discoverFlows>["flows"][number], nodes: ModuleFlowNode[]): string {
  const bodyNodes = flow.nodes.slice(1, -1);
  const statements = bodyNodes
    .map((node) => statementFor(node, nodes))
    .filter((line): line is string => Boolean(line));
  const inputMetadataComments = metadataCommentsFor(flow.input);
  const returnMetadataComments = flow.returnNode ? metadataCommentsFor(flow.returnNode) : "";
  const returnSource = flow.returnNode?.source ?? "input";

  return [
    `export async function ${flow.input.functionName}(input) {`,
    ...(inputMetadataComments ? [inputMetadataComments] : []),
    ...statements,
    ...(returnMetadataComments ? [returnMetadataComments] : []),
    `  return ${returnSource};`,
    "}"
  ].join("\n");
}

export function buildRegion(functionName: string, nodes: ModuleFlowNode[], controlFlow?: ControlFlowEdge[]): string {
  const flows = controlFlow
    ? discoverFlows(nodes, controlFlow).flows.filter((flow) => flow.complete)
    : [];
  const functions = flows.map((flow) => buildFunction(flow, nodes));
  const markdownNodes = nodes
    .filter((node): node is Extract<ModuleFlowNode, { kind: "markdown" }> => node.kind === "markdown")
    .map(markdownCommentsFor)
    .filter((line): line is string => Boolean(line));

  if (functions.length === 0 && nodes.length > 0 && !controlFlow) {
    const inputNode = nodes.find((node): node is Extract<ModuleFlowNode, { kind: "input" }> => node.kind === "input");
    const returnNode = nodes.find((node): node is Extract<ModuleFlowNode, { kind: "return" }> => node.kind === "return");
    functions.push(buildFunction({
      input: inputNode ?? { id: "input", kind: "input", label: "input", functionName },
      returnNode,
      nodes,
      complete: true,
      errors: []
    }, nodes));
  }

  return [
    startMarker,
    ...functions,
    ...markdownNodes,
    endMarker
  ].join("\n\n");
}

export function upsertRegion(source: string, region: string): string {
  const inspection = assertWritableModuleFlowRegion(source);

  if (inspection.hasRegion) {
    const before = source.slice(0, inspection.start).trimEnd();
    const after = source.slice(inspection.regionEnd).trimStart();
    return `${before}\n\n${region}\n${after}`.trimEnd() + "\n";
  }

  return `${source.trimEnd()}\n\n${region}\n`;
}
