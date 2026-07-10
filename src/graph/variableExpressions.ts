import generate from "@babel/generator";
import { parseExpression } from "@babel/parser";
import * as t from "@babel/types";
import { VariableValueType } from "../types";
import { codeDependencies } from "./codeDependencies";

type NodeWithChildren = t.Node & Record<string, unknown>;

const visitorKeys: Record<string, string[]> = {
  ArrayExpression: ["elements"],
  ArrowFunctionExpression: ["params", "body"],
  AssignmentExpression: ["left", "right"],
  AssignmentPattern: ["left", "right"],
  AwaitExpression: ["argument"],
  BinaryExpression: ["left", "right"],
  CallExpression: ["callee", "arguments"],
  ConditionalExpression: ["test", "consequent", "alternate"],
  LogicalExpression: ["left", "right"],
  MemberExpression: ["object", "property"],
  NewExpression: ["callee", "arguments"],
  ObjectExpression: ["properties"],
  ObjectProperty: ["key", "value"],
  OptionalCallExpression: ["callee", "arguments"],
  OptionalMemberExpression: ["object", "property"],
  SequenceExpression: ["expressions"],
  SpreadElement: ["argument"],
  TemplateLiteral: ["expressions"],
  UnaryExpression: ["argument"],
  UpdateExpression: ["argument"]
};

function isNode(value: unknown): value is t.Node {
  return Boolean(value && typeof value === "object" && "type" in value && typeof (value as { type?: unknown }).type === "string");
}

function isReferencedIdentifier(node: t.Identifier, parent: t.Node | undefined): boolean {
  if (!parent) {
    return true;
  }

  if (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") {
    return parent.object === node || Boolean(parent.computed);
  }

  if (parent.type === "ObjectProperty") {
    return parent.value === node || Boolean(parent.computed);
  }

  if (
    parent.type === "ArrowFunctionExpression" ||
    parent.type === "AssignmentPattern" ||
    parent.type === "RestElement"
  ) {
    return false;
  }

  return true;
}

export function variableExpressionDependencies(valueType: VariableValueType, value: string): string[] {
  if (valueType !== "array" && valueType !== "object") {
    return [];
  }

  return codeDependencies(`const __moduleflowValue = ${value || (valueType === "array" ? "[]" : "{}")};`);
}

export function mapVariableExpression(valueType: VariableValueType, value: string, inputMappings: Record<string, string> = {}): string {
  const fallback = valueType === "array" ? "[]" : "{}";
  const rawValue = value.trim() || fallback;

  if (valueType !== "array" && valueType !== "object") {
    return rawValue;
  }

  let expression: t.Expression;
  try {
    expression = parseExpression(rawValue, {
      plugins: ["jsx", "typescript"]
    });
  } catch {
    return fallback;
  }

  const mapExpression = (node: t.Node, parent?: t.Node): t.Node => {
    if (t.isIdentifier(node) && isReferencedIdentifier(node, parent) && inputMappings[node.name]) {
      try {
        return parseExpression(inputMappings[node.name], { plugins: ["jsx", "typescript"] });
      } catch {
        return node;
      }
    }

    const keys = visitorKeys[node.type] ?? [];
    for (const key of keys) {
      const value = (node as NodeWithChildren)[key];
      if (Array.isArray(value)) {
        (node as NodeWithChildren)[key] = value.map((child) => isNode(child) ? mapExpression(child, node) : child);
      } else if (isNode(value)) {
        (node as NodeWithChildren)[key] = mapExpression(value, node);
        if (node.type === "ObjectProperty" && key === "value") {
          node.shorthand = false;
        }
      }
    }

    return node;
  };

  return generate(mapExpression(expression) as t.Expression).code;
}
