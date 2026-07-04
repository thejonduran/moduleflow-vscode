import { parse } from "@babel/parser";
import generate from "@babel/generator";
import * as t from "@babel/types";
import { ModuleExport, ExportParameter, MethodDefinition } from "../types";

function parseModule(source: string): t.File {
  return parse(source, {
    sourceType: "module",
    plugins: [
      "jsx",
      "typescript",
      "classProperties",
      "classPrivateProperties",
      "classPrivateMethods",
      "objectRestSpread",
      "optionalChaining",
      "nullishCoalescingOperator",
      "topLevelAwait"
    ]
  });
}

function tryParseModule(source: string): t.File | undefined {
  try {
    return parseModule(source);
  } catch {
    return undefined;
  }
}

function nodeSource(node: t.Node): string {
  return generate(node, { comments: false, compact: true }).code;
}

function paramName(param: t.Function["params"][number], index: number): string {
  if (t.isIdentifier(param)) {
    return param.name;
  }

  if (t.isAssignmentPattern(param)) {
    return paramName(param.left as t.Function["params"][number], index);
  }

  if (t.isRestElement(param)) {
    return paramName(param.argument as t.Function["params"][number], index);
  }

  if (t.isObjectPattern(param)) {
    return `object${index + 1}`;
  }

  if (t.isArrayPattern(param)) {
    return `array${index + 1}`;
  }

  return `arg${index + 1}`;
}

function parseParams(params: t.Function["params"]): ExportParameter[] {
  return params.map((param, index) => {
    const defaultValue = t.isAssignmentPattern(param) ? nodeSource(param.right) : undefined;

    return {
      name: paramName(param, index),
      required: defaultValue === undefined,
      defaultValue
    };
  });
}

function functionExport(name: string, node: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression): ModuleExport {
  return {
    kind: "function",
    name,
    async: node.async,
    params: parseParams(node.params),
    methods: []
  };
}

function constFunctionExport(name: string, node: t.FunctionExpression | t.ArrowFunctionExpression): ModuleExport {
  return {
    kind: "const",
    name,
    async: node.async,
    params: parseParams(node.params),
    methods: []
  };
}

function classExport(name: string, node: t.ClassDeclaration | t.ClassExpression): ModuleExport {
  const methods: MethodDefinition[] = [];
  let constructorParams: ExportParameter[] = [];

  for (const member of node.body.body) {
    if (!t.isClassMethod(member) && !t.isClassPrivateMethod(member)) {
      continue;
    }

    const keyName = t.isIdentifier(member.key)
      ? member.key.name
      : t.isPrivateName(member.key)
        ? member.key.id.name
        : t.isStringLiteral(member.key)
          ? member.key.value
          : undefined;

    if (!keyName) {
      continue;
    }

    if (member.kind === "constructor") {
      constructorParams = parseParams(member.params);
      continue;
    }

    methods.push({
      name: keyName,
      async: Boolean(member.async),
      params: parseParams(member.params)
    });
  }

  return {
    kind: "class",
    name,
    async: false,
    params: constructorParams,
    methods
  };
}

function declarationExport(node: t.Declaration): ModuleExport[] {
  if (t.isFunctionDeclaration(node) && node.id) {
    return [functionExport(node.id.name, node)];
  }

  if (t.isClassDeclaration(node) && node.id) {
    return [classExport(node.id.name, node)];
  }

  if (t.isVariableDeclaration(node)) {
    return node.declarations.flatMap((declaration) => {
      if (!t.isIdentifier(declaration.id)) {
        return [];
      }

      if (t.isFunctionExpression(declaration.init) || t.isArrowFunctionExpression(declaration.init)) {
        return [constFunctionExport(declaration.id.name, declaration.init)];
      }

      return [];
    });
  }

  return [];
}

function findDeclarationExport(ast: t.File, name: string): ModuleExport[] {
  for (const statement of ast.program.body) {
    if (t.isFunctionDeclaration(statement) && statement.id?.name === name) {
      return [functionExport(name, statement)];
    }

    if (t.isClassDeclaration(statement) && statement.id?.name === name) {
      return [classExport(name, statement)];
    }

    if (t.isVariableDeclaration(statement)) {
      for (const declaration of statement.declarations) {
        if (!t.isIdentifier(declaration.id) || declaration.id.name !== name) {
          continue;
        }

        if (t.isFunctionExpression(declaration.init) || t.isArrowFunctionExpression(declaration.init)) {
          return [constFunctionExport(name, declaration.init)];
        }
      }
    }
  }

  return [];
}

export function parseExports(source: string): ModuleExport[] {
  const ast = tryParseModule(source);
  if (!ast) {
    return [];
  }

  const exports: ModuleExport[] = [];

  for (const statement of ast.program.body) {
    if (t.isExportNamedDeclaration(statement)) {
      if (statement.declaration) {
        exports.push(...declarationExport(statement.declaration));
      }

      for (const specifier of statement.specifiers) {
        if (!t.isExportSpecifier(specifier) || !t.isIdentifier(specifier.local)) {
          continue;
        }
        exports.push(...findDeclarationExport(ast, specifier.local.name));
      }
    }
  }

  return exports;
}

export function stripModuleFlowRegion(source: string): string {
  return source.replace(/\/\/\s*@moduleflow:start[\s\S]*?\/\/\s*@moduleflow:end/g, "");
}

export function parseLocalFunctions(source: string): ModuleExport[] {
  const withoutRegion = stripModuleFlowRegion(source);
  const ast = tryParseModule(withoutRegion);
  if (!ast) {
    return [];
  }

  const locals: ModuleExport[] = [];

  for (const statement of ast.program.body) {
    if (t.isFunctionDeclaration(statement) && statement.id) {
      locals.push(functionExport(statement.id.name, statement));
    }

    if (t.isVariableDeclaration(statement)) {
      for (const declaration of statement.declarations) {
        if (!t.isIdentifier(declaration.id)) {
          continue;
        }

        if (t.isFunctionExpression(declaration.init) || t.isArrowFunctionExpression(declaration.init)) {
          locals.push(constFunctionExport(declaration.id.name, declaration.init));
        }
      }
    }
  }

  return locals;
}
