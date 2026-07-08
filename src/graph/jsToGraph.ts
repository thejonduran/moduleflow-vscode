import generate from "@babel/generator";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { inspectModuleFlowRegion } from "../codegen/moduleFlowRegion";
import { ControlFlowEdge, ExportParameter, ImportedToolModule, ModuleFlowModel, ModuleFlowNode, NodePosition } from "../types";

type ToolExportMatch = {
  toolModule: ImportedToolModule;
  toolExport: ImportedToolModule["exports"][number];
};

type Metadata = {
  nodeId?: string;
  kind?: string;
  position?: NodePosition;
  size?: {
    width: number;
    height: number;
  };
  description?: string;
  code?: string;
  markdown?: string;
};

export function createInitialModel(targetFile: string): ModuleFlowModel {
  return {
    targetFile,
    imports: [],
    controlFlow: [],
    nodes: [
      {
        id: "input",
        kind: "input",
        label: "input",
        functionName: "main",
        params: [{ name: "input", required: true }],
        returnSource: "input"
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

function paramsForFunction(functionNode: t.FunctionDeclaration): ExportParameter[] {
  if (functionNode.params.length === 0) {
    return [];
  }

  const params = functionNode.params.flatMap((param): ExportParameter[] => {
    if (t.isIdentifier(param)) {
      return [{ name: param.name, required: true }];
    }

    if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
      return [{
        name: param.left.name,
        required: false,
        defaultValue: generate(param.right).code
      }];
    }

    return [];
  });

  return params.length > 0 ? params : [{ name: "input", required: true }];
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
    const kindMatch = /\bkind:(\w+)/.exec(rest);
    if (kindMatch) {
      metadata.kind = kindMatch[1];
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

  const markdownMatch = /^@moduleflow:markdown\s+(\S+)\s+(.+)$/.exec(value);
  if (markdownMatch) {
    const [, nodeId, encodedMarkdown] = markdownMatch;
    return {
      nodeId,
      metadata: {
        nodeId,
        markdown: parseDescription(encodedMarkdown)
      }
    };
  }

  return undefined;
}

function parseCodeEndComment(value: string): string | undefined {
  const match = /^@moduleflow:node:end\s+(\S+)$/.exec(value.trim());
  return match?.[1];
}

function mergeMetadata(target: Metadata, source: Metadata): Metadata {
  return {
    ...target,
    ...source
  };
}

function metadataByNodeIdFromComments(comments: t.Comment[]): Map<string, Metadata> {
  const result = new Map<string, Metadata>();

  for (const comment of comments) {
    const parsed = parseMetadataComment(comment.value.trim());
    if (!parsed) {
      continue;
    }

    result.set(parsed.nodeId, mergeMetadata(result.get(parsed.nodeId) ?? {}, parsed.metadata));
  }

  return result;
}

function statementMetadataNodeId(comments: t.Comment[], inputNodeId: string): string | undefined {
  for (const comment of comments) {
    const value = comment.value.trim();
    if (!value.startsWith("@moduleflow:node ")) {
      continue;
    }

    const parsed = parseMetadataComment(value);
    if (!parsed || parsed.nodeId === inputNodeId || parsed.metadata.size || parsed.metadata.kind === "code") {
      continue;
    }

    return parsed.nodeId;
  }

  return undefined;
}

function readMetadataFromComments(comments: t.Comment[], inputNodeId = "input"): { input?: Metadata; current?: Metadata } {
  const byNodeId = metadataByNodeIdFromComments(comments);
  const currentNodeId = statementMetadataNodeId(comments, inputNodeId);

  return {
    input: byNodeId.get(inputNodeId),
    current: currentNodeId ? byNodeId.get(currentNodeId) : undefined
  };
}

function readInputMetadataFromComments(comments: t.Comment[]): Metadata | undefined {
  const byNodeId = metadataByNodeIdFromComments(comments);

  for (const comment of comments) {
    const parsed = parseMetadataComment(comment.value.trim());
    if (!parsed) {
      continue;
    }

    if (parsed.metadata.kind === "input" || parsed.nodeId === "input" || parsed.nodeId.startsWith("input-") || parsed.nodeId.endsWith("-input")) {
      return byNodeId.get(parsed.nodeId);
    }
  }

  return undefined;
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

function leadingCodeEndNodeId(statement: t.Statement): string | undefined {
  for (const comment of statementComments(statement)) {
    const nodeId = parseCodeEndComment(comment.value);
    if (nodeId) {
      return nodeId;
    }
  }

  return undefined;
}

function commentText(comment: t.Comment): string {
  return comment.type === "CommentBlock"
    ? `/*${comment.value}*/`
    : `//${comment.value}`;
}

function commentOnlyCodeBlock(comments: t.Comment[], nodeId: string): string | undefined {
  const startIndex = comments.findIndex((comment) => {
    const parsed = parseMetadataComment(comment.value.trim());
    return parsed?.nodeId === nodeId && parsed.metadata.kind === "code";
  });
  const endIndex = comments.findIndex((comment, index) =>
    index > startIndex && parseCodeEndComment(comment.value) === nodeId
  );

  if (startIndex < 0 || endIndex < 0) {
    return undefined;
  }

  return comments
    .slice(startIndex + 1, endIndex)
    .filter((comment) => !parseMetadataComment(comment.value.trim()) && !parseCodeEndComment(comment.value))
    .map(commentText)
    .join("\n");
}

function codeStartMetadataFromComments(comments: t.Comment[]): Metadata | undefined {
  const byNodeId = metadataByNodeIdFromComments(comments);

  for (const comment of comments) {
    const parsed = parseMetadataComment(comment.value.trim());
    if (parsed?.metadata.kind === "code") {
      return byNodeId.get(parsed.nodeId);
    }
  }

  return undefined;
}

function codeForStatements(statements: t.Statement[]): string {
  return statements
    .map((statement) => generate(statement, { comments: false }).code)
    .join("\n");
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

function findExecutedFunctionName(source: string): string | undefined {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx"],
    attachComment: true
  });
  const functionNames = new Set(findModuleFlowFunctions(source).map((functionNode) => functionNode.id?.name).filter(Boolean));
  let executedFunctionName: string | undefined;

  for (const statement of ast.program.body) {
    if (!t.isExpressionStatement(statement) || !t.isCallExpression(statement.expression)) {
      continue;
    }

    const callExpression = statement.expression;
    const functionName = identifierName(callExpression.callee);
    if (functionName && functionNames.has(functionName) && callExpression.arguments.length === 0) {
      executedFunctionName = functionName;
    }
  }

  return executedFunctionName;
}

function markdownNodesFromRegion(source: string): Array<Extract<ModuleFlowNode, { kind: "markdown" }>> {
  const comments: t.Comment[] = [];
  const commentPattern = /^[ \t]*\/\/(.*)$/gm;
  let match: RegExpExecArray | null;

  while ((match = commentPattern.exec(source))) {
    comments.push({
      type: "CommentLine",
      value: match[1]
    } as t.Comment);
  }

  const byNodeId = metadataByNodeIdFromComments(comments);
  const nodes: Array<Extract<ModuleFlowNode, { kind: "markdown" }>> = [];

  for (const metadata of byNodeId.values()) {
    if (metadata.kind !== "markdown") {
      continue;
    }

    const node: Extract<ModuleFlowNode, { kind: "markdown" }> = {
      id: metadata.nodeId ?? `markdown-${nodes.length + 1}`,
      kind: "markdown",
      label: "markdown",
      markdown: metadata.markdown ?? ""
    };
    if (metadata.position) {
      node.position = metadata.position;
    }
    if (metadata.size) {
      node.size = metadata.size;
    }
    if (metadata.description) {
      node.description = metadata.description;
    }
    nodes.push(node);
  }

  return nodes;
}

function moduleFlowRegion(source: string): string | undefined {
  const inspection = inspectModuleFlowRegion(source);
  if (!inspection.ok) {
    throw new Error(inspection.message);
  }
  if (!inspection.hasRegion) {
    return undefined;
  }

  return source.slice(inspection.contentStart, inspection.contentEnd);
}

export function createModelFromSource(targetFile: string, source: string, imports: ImportedToolModule[]): ModuleFlowModel {
  const model = createInitialModel(targetFile);
  model.imports = imports;

  const region = moduleFlowRegion(source);
  if (!region) {
    return model;
  }
  const markdownNodes = markdownNodesFromRegion(region);

  let functionNodes: t.FunctionDeclaration[];
  try {
    functionNodes = findModuleFlowFunctions(region);
  } catch {
    model.nodes.push(...markdownNodes);
    return model;
  }

  if (functionNodes.length === 0) {
    model.nodes = markdownNodes.length > 0 ? markdownNodes : model.nodes;
    return model;
  }

  const nodes: ModuleFlowNode[] = [];
  const controlFlow: ControlFlowEdge[] = [];
  const inputIdByFunctionName = new Map<string, string>();
  const paramsByFunctionName = new Map<string, ExportParameter[]>();
  const executedFunctionName = findExecutedFunctionName(region);
  functionNodes.forEach((functionNode, index) => {
    const functionName = functionNode.id?.name ?? `main${index + 1}`;
    let inputId = index === 0 ? "input" : `${functionName}-input`;
    const discoveredInputMetadata = functionNode.body.body[0]
      ? readInputMetadataFromComments(statementComments(functionNode.body.body[0]))
      : undefined;
    if (discoveredInputMetadata?.nodeId) {
      inputId = discoveredInputMetadata.nodeId;
    }
    inputIdByFunctionName.set(functionName, inputId);
    paramsByFunctionName.set(functionName, paramsForFunction(functionNode));
  });
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
      functionName,
      params: paramsForFunction(functionNode),
      execute: functionName === executedFunctionName && paramsForFunction(functionNode).length === 0 ? true : undefined
    };
    if (discoveredInputMetadata) {
      Object.assign(inputNode, discoveredInputMetadata);
    }
    const flowNodeIds: string[] = [];
    const parsedNodes: ModuleFlowNode[] = [];

    const instanceClasses = new Map<string, string>();
    const statementNodeIds: string[] = [];
    let nodeIndex = 1;

    for (let statementIndex = 0; statementIndex < functionNode.body.body.length; statementIndex += 1) {
      const statement = functionNode.body.body[statementIndex];
      const metadata = readMetadataFromComments(statementComments(statement), inputId);
      if (metadata.input) {
        Object.assign(inputNode, metadata.input);
      }

      const codeStartMetadata = codeStartMetadataFromComments(statementComments(statement));
      if (codeStartMetadata) {
        const nodeId = codeStartMetadata.nodeId ?? `${functionName}-node-${nodeIndex++}`;
        const inlineCode = commentOnlyCodeBlock(statementComments(statement), nodeId);
        if (inlineCode !== undefined) {
          parsedNodes.push({
            id: nodeId,
            kind: "code",
            label: "code",
            code: inlineCode,
            position: codeStartMetadata.position,
            description: codeStartMetadata.description
          });
          statementNodeIds.push(nodeId);
        } else {
          const codeStatements: t.Statement[] = [statement];
          let endIndex = statementIndex;

          for (let nextIndex = statementIndex + 1; nextIndex < functionNode.body.body.length; nextIndex += 1) {
            const nextStatement = functionNode.body.body[nextIndex];
            if (leadingCodeEndNodeId(nextStatement) === nodeId) {
              endIndex = nextIndex - 1;
              break;
            }

            codeStatements.push(nextStatement);
            endIndex = nextIndex;
          }

          parsedNodes.push({
            id: nodeId,
            kind: "code",
            label: "code",
            code: codeForStatements(codeStatements),
            position: codeStartMetadata.position,
            description: codeStartMetadata.description
          });
          statementNodeIds.push(nodeId);
          statementIndex = endIndex;
          continue;
        }
      }

      if (t.isReturnStatement(statement)) {
        if (statement.argument) {
          inputNode.returnSource = generate(statement.argument).code;
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
        const moduleFlowInputId = inputIdByFunctionName.get(exportName);
        if (moduleFlowInputId) {
          const moduleFlowParams = paramsByFunctionName.get(exportName) ?? paramsForArgs(args);
          const nodeId = currentMetadata.nodeId ?? `${functionName}-node-${nodeIndex++}`;
          parsedNodes.push({
            id: nodeId,
            kind: "moduleFlowCall",
            label: exportName,
            functionNodeId: moduleFlowInputId,
            inputMappings: mappingsFor(moduleFlowParams, args),
            variableName,
            position: currentMetadata.position,
            description: currentMetadata.description
          });
          statementNodeIds.push(nodeId);
          continue;
        }

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
    flowNodeIds.push(inputId, ...statementNodeIds);
    controlFlow.push(...flowNodeIds.slice(0, -1).map((from, index) => ({ from, to: flowNodeIds[index + 1] })));
    functionIndex += 1;
  }

  model.nodes = [...nodes, ...markdownNodes];
  model.controlFlow = controlFlow;
  return model;
}
