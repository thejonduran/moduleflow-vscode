import { parse } from "@babel/parser";
import type * as t from "@babel/types";

const globalNames = new Set([
  "AbortController",
  "Array",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Set",
  "String",
  "URL",
  "console",
  "document",
  "fetch",
  "globalThis",
  "localStorage",
  "process",
  "setInterval",
  "setTimeout",
  "window"
]);

const visitorKeys: Record<string, string[]> = {
  ArrayExpression: ["elements"],
  ArrayPattern: ["elements"],
  ArrowFunctionExpression: ["params", "body"],
  AssignmentExpression: ["left", "right"],
  AssignmentPattern: ["left", "right"],
  AwaitExpression: ["argument"],
  BinaryExpression: ["left", "right"],
  BlockStatement: ["body"],
  CallExpression: ["callee", "arguments"],
  CatchClause: ["param", "body"],
  ConditionalExpression: ["test", "consequent", "alternate"],
  ExpressionStatement: ["expression"],
  ForInStatement: ["left", "right", "body"],
  ForOfStatement: ["left", "right", "body"],
  ForStatement: ["init", "test", "update", "body"],
  FunctionDeclaration: ["id", "params", "body"],
  FunctionExpression: ["id", "params", "body"],
  Identifier: [],
  IfStatement: ["test", "consequent", "alternate"],
  LogicalExpression: ["left", "right"],
  MemberExpression: ["object", "property"],
  NewExpression: ["callee", "arguments"],
  ObjectExpression: ["properties"],
  ObjectPattern: ["properties"],
  ObjectProperty: ["key", "value"],
  OptionalCallExpression: ["callee", "arguments"],
  OptionalMemberExpression: ["object", "property"],
  Program: ["body"],
  RestElement: ["argument"],
  ReturnStatement: ["argument"],
  SequenceExpression: ["expressions"],
  SpreadElement: ["argument"],
  TemplateLiteral: ["expressions"],
  UnaryExpression: ["argument"],
  UpdateExpression: ["argument"],
  VariableDeclaration: ["declarations"],
  VariableDeclarator: ["id", "init"]
};

type NodeWithChildren = t.Node & Record<string, unknown>;

type Scope = {
  names: Set<string>;
  parent?: Scope;
};

function isNode(value: unknown): value is t.Node {
  return Boolean(value && typeof value === "object" && "type" in value && typeof (value as { type?: unknown }).type === "string");
}

function collectPatternNames(pattern: t.Node | null | undefined): string[] {
  if (!pattern) {
    return [];
  }

  if (pattern.type === "Identifier") {
    return [pattern.name];
  }

  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) => {
      if (property.type === "ObjectProperty") {
        return collectPatternNames(property.value);
      }

      if (property.type === "RestElement") {
        return collectPatternNames(property.argument);
      }

      return [];
    });
  }

  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => collectPatternNames(element));
  }

  if (pattern.type === "AssignmentPattern") {
    return collectPatternNames(pattern.left);
  }

  if (pattern.type === "RestElement") {
    return collectPatternNames(pattern.argument);
  }

  return [];
}

function addBindingNames(node: t.Node, names: Set<string>): void {
  if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations) {
      for (const name of collectPatternNames(declaration.id)) {
        names.add(name);
      }
    }
    return;
  }

  if (node.type === "FunctionDeclaration") {
    if (node.id) {
      names.add(node.id.name);
    }
    for (const param of node.params) {
      for (const name of collectPatternNames(param)) {
        names.add(name);
      }
    }
    return;
  }

  if (node.type === "ClassDeclaration" && node.id) {
    names.add(node.id.name);
    return;
  }

  if (node.type === "ImportDeclaration") {
    for (const specifier of node.specifiers) {
      names.add(specifier.local.name);
    }
  }
}

function isReferencedIdentifier(node: t.Identifier, parent: t.Node, grandparent: t.Node | undefined): boolean {
  if (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") {
    if (parent.property === node) {
      return Boolean(parent.computed);
    }
    return parent.object === node;
  }

  if (parent.type === "VariableDeclarator") {
    return parent.init === node;
  }

  if (parent.type === "ObjectProperty") {
    if (parent.key === node) {
      return Boolean(parent.computed);
    }
    return grandparent?.type !== "ObjectPattern";
  }

  if (parent.type === "AssignmentExpression") {
    return parent.right === node;
  }

  if (parent.type === "AssignmentPattern") {
    return parent.right === node;
  }

  if (
    parent.type === "FunctionDeclaration" ||
    parent.type === "FunctionExpression" ||
    parent.type === "ArrowFunctionExpression" ||
    parent.type === "RestElement" ||
    parent.type === "CatchClause" ||
    parent.type === "ImportSpecifier" ||
    parent.type === "ImportDefaultSpecifier" ||
    parent.type === "ImportNamespaceSpecifier" ||
    parent.type === "ObjectPattern" ||
    parent.type === "ArrayPattern"
  ) {
    return false;
  }

  return true;
}

function hasScopeName(scope: Scope, name: string): boolean {
  let current: Scope | undefined = scope;
  while (current) {
    if (current.names.has(name)) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

function childScopeFor(node: t.Node, parentScope: Scope): Scope {
  const names = new Set<string>();

  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    if (node.type === "FunctionExpression" && node.id) {
      names.add(node.id.name);
    }

    for (const param of node.params) {
      for (const name of collectPatternNames(param)) {
        names.add(name);
      }
    }
  }

  if (node.type === "CatchClause" && node.param) {
    for (const name of collectPatternNames(node.param)) {
      names.add(name);
    }
  }

  return { names, parent: parentScope };
}

function visitNodeWithScope(
  node: t.Node | null | undefined,
  parent: t.Node | undefined,
  grandparent: t.Node | undefined,
  scope: Scope,
  visit: (node: t.Node, parent: t.Node | undefined, grandparent: t.Node | undefined, scope: Scope) => void
): void {
  if (!node) {
    return;
  }

  const currentScope = (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "CatchClause"
  )
    ? childScopeFor(node, scope)
    : scope;

  visit(node, parent, grandparent, currentScope);

  const keys = visitorKeys[node.type] ?? [];
  for (const key of keys) {
    const value = (node as NodeWithChildren)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) {
          visitNodeWithScope(child, node, parent, currentScope, visit);
        }
      }
    } else if (isNode(value)) {
      visitNodeWithScope(value, node, parent, currentScope, visit);
    }
  }
}

export function codeDependencies(code: string): string[] {
  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });
  } catch {
    return [];
  }

  const rootScope: Scope = { names: new Set<string>() };
  for (const statement of ast.program.body) {
    addBindingNames(statement, rootScope.names);
  }

  const dependencies: string[] = [];
  const seen = new Set<string>();

  visitNodeWithScope(ast.program, undefined, undefined, rootScope, (node, parent, grandparent, scope) => {
    if (node.type !== "Identifier" || !parent || !isReferencedIdentifier(node, parent, grandparent)) {
      return;
    }

    if (hasScopeName(scope, node.name) || globalNames.has(node.name) || seen.has(node.name)) {
      return;
    }

    seen.add(node.name);
    dependencies.push(node.name);
  });

  return dependencies;
}
