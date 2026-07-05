import { ControlFlowEdge, ModuleFlowNode } from "../types";
import { codeOutputs } from "./codeOutputs";

export type DiscoveredFlow = {
  input: Extract<ModuleFlowNode, { kind: "input" }>;
  returnNode?: Extract<ModuleFlowNode, { kind: "return" }>;
  nodes: ModuleFlowNode[];
  complete: boolean;
  errors: string[];
};

export type FlowDiscovery = {
  flows: DiscoveredFlow[];
  ownerByNodeId: Map<string, string>;
};

export function discoverFlows(nodes: ModuleFlowNode[], controlFlow: ControlFlowEdge[]): FlowDiscovery {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const nextByFrom = new Map(controlFlow.map((edge) => [edge.from, edge.to]));
  const ownerByNodeId = new Map<string, string>();
  const flows: DiscoveredFlow[] = [];

  for (const input of nodes.filter((node): node is Extract<ModuleFlowNode, { kind: "input" }> => node.kind === "input")) {
    const flowNodes: ModuleFlowNode[] = [input];
    const errors: string[] = [];
    const seen = new Set<string>([input.id]);
    let returnNode: Extract<ModuleFlowNode, { kind: "return" }> | undefined;
    let currentId = nextByFrom.get(input.id);

    ownerByNodeId.set(input.id, input.id);

    while (currentId) {
      if (seen.has(currentId)) {
        errors.push("cycle");
        break;
      }
      seen.add(currentId);

      const node = nodesById.get(currentId);
      if (!node) {
        errors.push("missing-node");
        break;
      }

      const existingOwner = ownerByNodeId.get(node.id);
      if (existingOwner && existingOwner !== input.id) {
        errors.push("shared-node");
      } else {
        ownerByNodeId.set(node.id, input.id);
      }

      flowNodes.push(node);

      if (node.kind === "return") {
        returnNode = node;
        break;
      }

      currentId = nextByFrom.get(node.id);
    }

    flows.push({
      input,
      returnNode,
      nodes: flowNodes,
      complete: Boolean(returnNode) && errors.length === 0,
      errors
    });
  }

  return { flows, ownerByNodeId };
}

export function previousScopedSources(
  nodes: ModuleFlowNode[],
  controlFlow: ControlFlowEdge[],
  targetNodeId: string
): string[] {
  const { flows } = discoverFlows(nodes, controlFlow);
  const flow = flows.find((item) => item.nodes.some((node) => node.id === targetNodeId));
  if (!flow) {
    return [];
  }

  const targetIndex = flow.nodes.findIndex((node) => node.id === targetNodeId);
  return flow.nodes.slice(0, targetIndex).flatMap((node) => {
    if ("variableName" in node) {
      return [node.variableName];
    }

    if (node.kind === "code") {
      return codeOutputs(node.code);
    }

    return [];
  });
}
