import { VariableValueType } from "../types";
import { codeDependencies } from "./codeDependencies";

export function variableExpressionDependencies(valueType: VariableValueType, value: string): string[] {
  if (valueType !== "array" && valueType !== "object") {
    return [];
  }

  return codeDependencies(`const __moduleflowValue = ${value || (valueType === "array" ? "[]" : "{}")};`);
}
