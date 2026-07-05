import { ControlFlowEdge, ModuleFlowNode } from "../types";
import { discoverFlows } from "../graph/flowDiscovery";

const startMarker = "// @moduleflow:start";
const endMarker = "// @moduleflow:end";

function positionCommentFor(node: ModuleFlowNode): string | undefined {
  const metadataParts = [
    node.position ? `x:${Math.round(node.position.x)}` : undefined,
    node.position ? `y:${Math.round(node.position.y)}` : undefined,
    node.kind === "code" ? "kind:code" : undefined
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

function argsFor(
  params: { name: string; required: boolean; defaultValue?: string }[],
  inputMappings: Record<string, string> = {}
): string {
  return params.map((param) => inputMappings[param.name] ?? param.defaultValue ?? `input.${param.name}`).join(", ");
}

function statementFor(node: ModuleFlowNode): string | undefined {
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
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  return start >= 0 && end > start;
}

function buildFunction(flow: ReturnType<typeof discoverFlows>["flows"][number]): string {
  const bodyNodes = flow.nodes.slice(1, -1);
  const statements = bodyNodes
    .map((node) => statementFor(node))
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
  const functions = flows.map(buildFunction);

  if (functions.length === 0 && nodes.length > 0 && !controlFlow) {
    const inputNode = nodes.find((node): node is Extract<ModuleFlowNode, { kind: "input" }> => node.kind === "input");
    const returnNode = nodes.find((node): node is Extract<ModuleFlowNode, { kind: "return" }> => node.kind === "return");
    functions.push(buildFunction({
      input: inputNode ?? { id: "input", kind: "input", label: "input", functionName },
      returnNode,
      nodes,
      complete: true,
      errors: []
    }));
  }

  return [
    startMarker,
    ...functions,
    endMarker
  ].join("\n\n");
}

export function upsertRegion(source: string, region: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);

  if (start >= 0 && end > start) {
    const before = source.slice(0, start).trimEnd();
    const after = source.slice(end + endMarker.length).trimStart();
    return `${before}\n\n${region}\n${after}`.trimEnd() + "\n";
  }

  return `${source.trimEnd()}\n\n${region}\n`;
}
