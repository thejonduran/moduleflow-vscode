import { ControlFlowEdge, ModuleFlowNode } from "../types";
import { codeOutputs } from "./codeOutputs";

export type DiscoveredFlow = {
  input: Extract<ModuleFlowNode, { kind: "input" }>;
  nodes: ModuleFlowNode[];
  complete: boolean;
  errors: string[];
};

export type FlowDiscovery = {
  flows: DiscoveredFlow[];
  ownerByNodeId: Map<string, string>;
};

export type ScopedSourceRef = {
  nodeId: string;
  name: string;
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

      currentId = nextByFrom.get(node.id);
    }

    flows.push({
      input,
      nodes: flowNodes,
      complete: errors.length === 0,
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
  return previousScopedSourceRefs(nodes, controlFlow, targetNodeId).map((source) => source.name);
}

export function previousScopedSourceRefs(
  nodes: ModuleFlowNode[],
  controlFlow: ControlFlowEdge[],
  targetNodeId: string
): ScopedSourceRef[] {
  const { flows } = discoverFlows(nodes, controlFlow);
  const flow = flows.find((item) => item.nodes.some((node) => node.id === targetNodeId));
  if (!flow) {
    return [];
  }

  const targetIndex = flow.nodes.findIndex((node) => node.id === targetNodeId);
  return flow.nodes.slice(0, targetIndex).flatMap((node) => {
    if (node.kind === "input") {
      return (node.params === undefined ? [{ name: "input" }] : node.params)
        .map((param) => ({ nodeId: node.id, name: param.name }));
    }

    if ("variableName" in node) {
      return [{ nodeId: node.id, name: node.variableName }];
    }

    if (node.kind === "code") {
      return codeOutputs(node.code).map((name) => ({ nodeId: node.id, name }));
    }

    return [];
  });
}
