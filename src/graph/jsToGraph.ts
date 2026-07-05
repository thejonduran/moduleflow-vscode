import generate from "@babel/generator";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { ControlFlowEdge, ImportedToolModule, ModuleFlowModel, ModuleFlowNode, NodePosition } from "../types";

type ToolExportMatch = {
  toolModule: ImportedToolModule;
  toolExport: ImportedToolModule["exports"][number];
};

type Metadata = {
  nodeId?: string;
  position?: NodePosition;
  size?: {
    width: number;
    height: number;
  };
  description?: string;
  code?: string;
};

export function createInitialModel(targetFile: string): ModuleFlowModel {
  return {
    targetFile,
    imports: [],
    controlFlow: [
      {
        from: "input",
        to: "return"
      }
    ],
    nodes: [
      {
        id: "input",
        kind: "input",
        label: "input",
        functionName: "main"
      },
      {
        id: "return",
        kind: "return",
        label: "return",
        source: "input"
      }
    ]
  };
}

function mappingsFor(params: { name: string }[], args: string[]): Record<string, string> {
  return Object.fromEntries(params.map((param, index) => [param.name, args[index] ?? `input.${param.name}`]));
}

function paramsForArgs(args: string[]): { name: string; required: boolean }[] {
  return args.map((_, index) => ({
    name: `arg${index + 1}`,
    required: true
  }));
}

function findImportedExport(imports: ImportedToolModule[], exportName: string): ToolExportMatch | undefined {
  for (const toolModule of imports) {
    const toolExport = toolModule.exports.find((item) => item.name === exportName || item.callName === exportName);
    if (toolExport) {
      return { toolModule, toolExport };
    }
  }

  return undefined;
}

function statementComments(statement: t.Statement): t.Comment[] {
  return statement.leadingComments ?? [];
}

function parseDescription(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
}

function parseMetadataComment(value: string): { nodeId: string; metadata: Metadata } | undefined {
  const positionMatch = /^@moduleflow:node\s+(\S+)\s+(.+)$/.exec(value);
  if (positionMatch) {
    const [, nodeId, rest] = positionMatch;
    const metadata: Metadata = { nodeId };
    const xMatch = /\bx:(-?\d+(?:\.\d+)?)/.exec(rest);
    const yMatch = /\by:(-?\d+(?:\.\d+)?)/.exec(rest);
    const widthMatch = /\bw:(-?\d+(?:\.\d+)?)/.exec(rest);
    const heightMatch = /\bh:(-?\d+(?:\.\d+)?)/.exec(rest);

    if (xMatch && yMatch) {
      metadata.position = {
        x: Number(xMatch[1]),
        y: Number(yMatch[1])
      };
    }
    if (widthMatch && heightMatch) {
      metadata.size = {
        width: Number(widthMatch[1]),
        height: Number(heightMatch[1])
      };
    }
    return { nodeId, metadata };
  }

  const descriptionMatch = /^@moduleflow:description\s+(\S+)\s+(.+)$/.exec(value);
  if (descriptionMatch) {
    const [, nodeId, encodedDescription] = descriptionMatch;
    return {
      nodeId,
      metadata: {
        nodeId,
        description: parseDescription(encodedDescription)
      }
    };
  }

  const codeMatch = /^@moduleflow:code\s+(\S+)\s+(.+)$/.exec(value);
  if (codeMatch) {
    const [, nodeId, encodedCode] = codeMatch;
    return {
      nodeId,
      metadata: {
        nodeId,
        code: parseDescription(encodedCode)
      }
    };
  }

  return undefined;
}

function mergeMetadata(target: Metadata, source: Metadata): Metadata {
  return {
    ...target,
    ...source
  };
}

function readMetadataFromComments(comments: t.Comment[], inputNodeId = "input"): { input?: Metadata; current?: Metadata } {
  const result: { input?: Metadata; current?: Metadata } = {};

  for (const comment of comments) {
    const parsed = parseMetadataComment(comment.value.trim());
    if (!parsed) {
      continue;
    }

    if (parsed.nodeId === inputNodeId) {
      result.input = mergeMetadata(result.input ?? {}, parsed.metadata);
    } else if (!parsed.metadata.size) {
      result.current = mergeMetadata(result.current ?? {}, parsed.metadata);
    }
  }

  return result;
}

function readInputMetadataFromComments(comments: t.Comment[]): Metadata | undefined {
  let result: Metadata | undefined;

  for (const comment of comments) {
    const parsed = parseMetadataComment(comment.value.trim());
    if (!parsed) {
      continue;
    }

    if (parsed.nodeId === "input" || parsed.nodeId.endsWith("-input")) {
      result = mergeMetadata(result ?? {}, parsed.metadata);
    }
  }

  return result;
}

function variableDeclarator(statement: t.Statement): { variableName: string; init: t.Expression } | undefined {
  if (!t.isVariableDeclaration(statement) || statement.declarations.length !== 1) {
    return undefined;
  }

  const [declarator] = statement.declarations;
  if (!t.isIdentifier(declarator.id) || !declarator.init || !t.isExpression(declarator.init)) {
    return undefined;
  }

  return {
    variableName: declarator.id.name,
    init: declarator.init
  };
}

function unwrapAwait(expression: t.Expression): { expression: t.Expression; async: boolean } {
  if (t.isAwaitExpression(expression) && t.isExpression(expression.argument)) {
    return {
      expression: expression.argument,
      async: true
    };
  }

  return {
    expression,
    async: false
  };
}

function identifierName(node: t.Node | null | undefined): string | undefined {
  return t.isIdentifier(node) ? node.name : undefined;
}

function statementCountForCode(code: string): number {
  try {
    const ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx"],
      attachComment: true
    });
    return Math.max(1, ast.program.body.length);
  } catch {
    return 1;
  }
}

function findModuleFlowFunctions(source: string): t.FunctionDeclaration[] {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx"],
    attachComment: true
  });

  const functions: t.FunctionDeclaration[] = [];
  for (const statement of ast.program.body) {
    if (t.isExportNamedDeclaration(statement) && t.isFunctionDeclaration(statement.declaration)) {
      functions.push(statement.declaration);
      continue;
    }

    if (t.isFunctionDeclaration(statement)) {
      functions.push(statement);
    }
  }

  return functions;
}

function moduleFlowRegion(source: string): string | undefined {
  const startMarker = "// @moduleflow:start";
  const endMarker = "// @moduleflow:end";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end <= start) {
    return undefined;
  }

  return source.slice(start + startMarker.length, end);
}

export function createModelFromSource(targetFile: string, source: string, imports: ImportedToolModule[]): ModuleFlowModel {
  const model = createInitialModel(targetFile);
  model.imports = imports;

  const region = moduleFlowRegion(source);
  if (!region) {
    return model;
  }

  let functionNodes: t.FunctionDeclaration[];
  try {
    functionNodes = findModuleFlowFunctions(region);
  } catch {
    return model;
  }

  if (functionNodes.length === 0) {
    return model;
  }

  const nodes: ModuleFlowNode[] = [];
  const controlFlow: ControlFlowEdge[] = [];
  let functionIndex = 0;

  for (const functionNode of functionNodes) {
    const functionName = functionNode.id?.name ?? `main${functionIndex + 1}`;
    let inputId = functionIndex === 0 ? "input" : `${functionName}-input`;
    let returnId = functionIndex === 0 ? "return" : `${functionName}-return`;
    const discoveredInputMetadata = functionNode.body.body[0]
      ? readInputMetadataFromComments(statementComments(functionNode.body.body[0]))
      : undefined;
    if (discoveredInputMetadata?.nodeId) {
      inputId = discoveredInputMetadata.nodeId;
    }
    const inputNode: Extract<ModuleFlowNode, { kind: "input" }> = {
      id: inputId,
      kind: "input",
      label: "input",
      functionName
    };
    if (discoveredInputMetadata) {
      Object.assign(inputNode, discoveredInputMetadata);
    }
    const flowNodeIds: string[] = [];
    const parsedNodes: ModuleFlowNode[] = [];

    const instanceClasses = new Map<string, string>();
    const statementNodeIds: string[] = [];
    let returnSource = "input";
    let returnMetadata: Metadata = {};
    let nodeIndex = 1;

    for (let statementIndex = 0; statementIndex < functionNode.body.body.length; statementIndex += 1) {
      const statement = functionNode.body.body[statementIndex];
      const metadata = readMetadataFromComments(statementComments(statement), inputId);
      if (metadata.input) {
        Object.assign(inputNode, metadata.input);
      }

      if (t.isReturnStatement(statement)) {
        if (statement.argument) {
          returnSource = generate(statement.argument).code;
        }
        returnMetadata = metadata.current ?? {};
        if (returnMetadata.nodeId) {
          returnId = returnMetadata.nodeId;
        }
        continue;
      }

      if (metadata.current?.code) {
        const nodeId = metadata.current.nodeId ?? `${functionName}-node-${nodeIndex++}`;
        parsedNodes.push({
          id: nodeId,
          kind: "code",
          label: "code",
          code: metadata.current.code,
          position: metadata.current.position,
          description: metadata.current.description
        });
        statementNodeIds.push(nodeId);
        statementIndex += statementCountForCode(metadata.current.code) - 1;
        continue;
      }

      const declarator = variableDeclarator(statement);
      if (!declarator) {
        continue;
      }

      const { variableName } = declarator;
      const { expression, async } = unwrapAwait(declarator.init);
      const currentMetadata = metadata.current ?? {};

      if (t.isNewExpression(expression)) {
        const exportName = identifierName(expression.callee);
        const found = exportName ? findImportedExport(imports, exportName) : undefined;
        if (!exportName) {
          continue;
        }

        const args = expression.arguments.map((arg) => generate(arg).code);
        const params = found?.toolExport.kind === "class" ? found.toolExport.params : paramsForArgs(args);
        instanceClasses.set(variableName, found?.toolExport.name ?? exportName);
        const nodeId = currentMetadata.nodeId ?? `${functionName}-node-${nodeIndex++}`;
        parsedNodes.push({
          id: nodeId,
          kind: "classInstance",
          label: `new ${found?.toolExport.name ?? exportName}`,
          modulePath: found?.toolModule.modulePath ?? "moduleflow:missing",
          exportName: found?.toolExport.name ?? exportName,
          callName: found?.toolExport.callName ?? exportName,
          params,
          inputMappings: mappingsFor(params, args),
          variableName,
          position: currentMetadata.position,
          description: currentMetadata.description,
          warning: found?.toolExport.kind === "class" ? undefined : `Class export "${exportName}" was not found.`
        });
        statementNodeIds.push(nodeId);
        continue;
      }

      if (t.isCallExpression(expression) && t.isMemberExpression(expression.callee)) {
        const instanceVariableName = identifierName(expression.callee.object);
        const methodName = identifierName(expression.callee.property);
        const exportName = instanceVariableName ? instanceClasses.get(instanceVariableName) : undefined;
        const found = exportName ? findImportedExport(imports, exportName) : undefined;
        const method = found?.toolExport.methods.find((item) => item.name === methodName);
        if (!instanceVariableName || !methodName) {
          continue;
        }

        const args = expression.arguments.map((arg) => generate(arg).code);
        const params = method?.params ?? paramsForArgs(args);
        const nodeId = currentMetadata.nodeId ?? `${functionName}-node-${nodeIndex++}`;
        parsedNodes.push({
          id: nodeId,
          kind: "methodCall",
          label: `${instanceVariableName}.${methodName}`,
          instanceVariableName,
          methodName,
          params,
          inputMappings: mappingsFor(params, args),
          variableName,
          async: method?.async || async,
          position: currentMetadata.position,
          description: currentMetadata.description,
          warning: method ? undefined : `Method "${methodName}" was not found on "${exportName ?? instanceVariableName}".`
        });
        statementNodeIds.push(nodeId);
        continue;
      }

      if (t.isCallExpression(expression)) {
        const exportName = identifierName(expression.callee);
        const found = exportName ? findImportedExport(imports, exportName) : undefined;
        if (!exportName) {
          continue;
        }

        const args = expression.arguments.map((arg) => generate(arg).code);
        const params = found && found.toolExport.kind !== "class" ? found.toolExport.params : paramsForArgs(args);
        const nodeId = currentMetadata.nodeId ?? `${functionName}-node-${nodeIndex++}`;
        parsedNodes.push({
          id: nodeId,
          kind: "call",
          label: found?.toolExport.name ?? exportName,
          modulePath: found?.toolModule.modulePath ?? "moduleflow:missing",
          exportName: found?.toolExport.name ?? exportName,
          callName: found?.toolExport.callName ?? exportName,
          params,
          inputMappings: mappingsFor(params, args),
          variableName,
          async: found?.toolExport.async || async,
          position: currentMetadata.position,
          description: currentMetadata.description,
          warning: found && found.toolExport.kind !== "class" ? undefined : `Function export "${exportName}" was not found.`
        });
        statementNodeIds.push(nodeId);
        continue;
      }
    }

    nodes.push(inputNode, ...parsedNodes);
    const returnNode: ModuleFlowNode = {
      id: returnId,
      kind: "return",
      label: "return",
      source: returnSource,
      position: returnMetadata.position,
      description: returnMetadata.description
    };
    nodes.push(returnNode);
    flowNodeIds.push(inputId, ...statementNodeIds, returnId);
    controlFlow.push(...flowNodeIds.slice(0, -1).map((from, index) => ({ from, to: flowNodeIds[index + 1] })));
    functionIndex += 1;
  }

  model.nodes = nodes;
  model.controlFlow = controlFlow;
  return model;
}
