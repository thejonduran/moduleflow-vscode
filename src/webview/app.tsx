import React, { memo, useCallback, useEffect, useRef, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  Background,
  Connection,
  Controls,
  Edge,
  Handle,
  MiniMap,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useViewport,
  useUpdateNodeInternals,
  useReactFlow,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ExportParameter, ModuleFlowModel, ModuleFlowNode } from "../types";
import { codeDependencies } from "../graph/codeDependencies";
import { codeOutputs } from "../graph/codeOutputs";
import { discoverFlows, previousScopedSourceRefs, previousScopedSources } from "../graph/flowDiscovery";

declare const acquireVsCodeApi: () => {
  postMessage: (message: unknown) => void;
};

const vscode = typeof acquireVsCodeApi === "function"
  ? acquireVsCodeApi()
  : {
      postMessage(message: unknown) {
        console.log("[ModuleFlow preview postMessage]", message);
      }
    };

const moduleFlowHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#c586c0" },
  { tag: [tags.name, tags.variableName], color: "#9cdcfe" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "#dcdcaa" },
  { tag: [tags.string, tags.special(tags.string)], color: "#ce9178" },
  { tag: [tags.number, tags.bool, tags.null], color: "#b5cea8" },
  { tag: tags.comment, color: "#6a9955", fontStyle: "italic" },
  { tag: tags.operator, color: "#d4d4d4" },
  { tag: tags.punctuation, color: "#d4d4d4" }
]);

type FlowNodeData = {
  node: ModuleFlowNode;
  sources: string[];
  model?: ModuleFlowModel;
  onModelChange?: (model: ModuleFlowModel) => void;
};

type ToolDragPayload =
  | {
      type: "addFunction";
    }
  | {
      type: "addCodeNode";
    }
  | {
      type: "addNode";
      modulePath: string;
      exportName: string;
      methodName: string | null;
    }
  | {
      type: "addModuleFlowCall";
      functionNodeId: string;
    }
  | {
      type: "addMarkdownNode";
    };

type CanvasContextMenuState = {
  x: number;
  y: number;
  position: { x: number; y: number };
};

function hasVariable(node: ModuleFlowNode): node is Extract<ModuleFlowNode, { variableName: string }> {
  return "variableName" in node;
}

function hasParams(node: ModuleFlowNode): node is Extract<ModuleFlowNode, { params: { name: string }[]; inputMappings: Record<string, string> }> {
  return "params" in node && "inputMappings" in node;
}

function hasInputMappings(node: ModuleFlowNode): node is Extract<ModuleFlowNode, { inputMappings: Record<string, string> }> {
  return "inputMappings" in node;
}

function moduleFlowFunctions(model: ModuleFlowModel): Array<Extract<ModuleFlowNode, { kind: "input" }>> {
  return model.nodes.filter((node): node is Extract<ModuleFlowNode, { kind: "input" }> => node.kind === "input");
}

function moduleFlowFunctionFor(model: ModuleFlowModel | undefined, functionNodeId: string): Extract<ModuleFlowNode, { kind: "input" }> | undefined {
  return model?.nodes.find((node): node is Extract<ModuleFlowNode, { kind: "input" }> =>
    node.kind === "input" && node.id === functionNodeId
  );
}

function inputParamsFor(node: Extract<ModuleFlowNode, { kind: "input" }> | undefined): ExportParameter[] {
  return node?.params === undefined ? [{ name: "input", required: true }] : node.params;
}

function moduleFlowCallParams(model: ModuleFlowModel | undefined, node: Extract<ModuleFlowNode, { kind: "moduleFlowCall" }>): ExportParameter[] {
  return inputParamsFor(moduleFlowFunctionFor(model, node.functionNodeId));
}

function outputNamesForNode(node: ModuleFlowNode): string[] {
  if (node.kind === "input") {
    return inputParamsFor(node).map((param) => param.name);
  }

  if (hasVariable(node)) {
    return [node.variableName];
  }

  if (node.kind === "code") {
    return codeOutputs(node.code);
  }

  return [];
}

function nodePosition(node: ModuleFlowNode, index: number) {
  if (node.position) {
    return node.position;
  }

  if (node.kind === "input") {
    return { x: 80, y: 120 };
  }

  return { x: 240 + index * 210, y: 120 };
}

function codeNodeWidth(code: string): number {
  const longestLine = code
    .split(/\r?\n/)
    .reduce((longest, line) => Math.max(longest, line.replace(/\t/g, "  ").length), 0);

  return Math.max(268, Math.min(760, 24 + longestLine * 7.25));
}

function markdownNodeSize(node: Extract<ModuleFlowNode, { kind: "markdown" }>): { width: number; height: number } {
  return {
    width: node.size?.width ?? 350,
    height: node.size?.height ?? 200
  };
}

function positionsWithAttachedMarkdown(
  model: ModuleFlowModel,
  positions: { nodeId: string; position: { x: number; y: number } }[]
): { nodeId: string; position: { x: number; y: number } }[] {
  const moved = new Map(positions.map((item) => [item.nodeId, item.position]));
  const originalPositions = new Map(model.nodes.map((node) => [node.id, node.position]));
  const expanded = [...positions];

  for (const node of model.nodes) {
    if (node.kind !== "markdown" || !node.parentNodeId || moved.has(node.id)) {
      continue;
    }

    const parentPosition = moved.get(node.parentNodeId);
    const originalParentPosition = originalPositions.get(node.parentNodeId);
    const originalMarkdownPosition = originalPositions.get(node.id);
    if (!parentPosition || !originalParentPosition || !originalMarkdownPosition) {
      continue;
    }

    expanded.push({
      nodeId: node.id,
      position: {
        x: originalMarkdownPosition.x + parentPosition.x - originalParentPosition.x,
        y: originalMarkdownPosition.y + parentPosition.y - originalParentPosition.y
      }
    });
  }

  return expanded;
}

function toFlowNodes(model: ModuleFlowModel, onModelChange?: (model: ModuleFlowModel) => void): Node<FlowNodeData>[] {
  return model.nodes
    .map((node, index) => ({
      id: node.id,
      type: "moduleFlow",
      position: nodePosition(node, index),
      data: { node, model, sources: outputSources(model, node), onModelChange }
    }));
}

function mergeFlowNodes(
  currentNodes: Node<FlowNodeData>[],
  model: ModuleFlowModel,
  onModelChange?: (model: ModuleFlowModel) => void
): Node<FlowNodeData>[] {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));

  return model.nodes.map((node, index) => {
    const current = currentById.get(node.id);
    return {
      id: node.id,
      type: "moduleFlow",
      position: current?.position ?? nodePosition(node, index),
      selected: current?.selected,
      data: { node, model, sources: outputSources(model, node), onModelChange }
    };
  });
}

function canUseSource(model: ModuleFlowModel, sourceNode: ModuleFlowNode, targetNode: ModuleFlowNode): boolean {
  if (sourceNode.kind === "input") {
    const { ownerByNodeId } = discoverFlows(model.nodes, model.controlFlow);
    return ownerByNodeId.get(targetNode.id) === sourceNode.id;
  }

  const scopedSources = previousScopedSourceRefs(model.nodes, model.controlFlow, targetNode.id);
  return outputNamesForNode(sourceNode).some((source) =>
    scopedSources.some((scopedSource) => scopedSource.nodeId === sourceNode.id && scopedSource.name === source)
  );
}

function sourceNodeIdFor(model: ModuleFlowModel, source: string, targetNode: ModuleFlowNode): string | undefined {
  if (source === "input" || source.startsWith("input.")) {
    const { flows } = discoverFlows(model.nodes, model.controlFlow);
    return flows.find((flow) => flow.nodes.some((node) => node.id === targetNode.id))?.input.id;
  }

  const scopedSource = previousScopedSourceRefs(model.nodes, model.controlFlow, targetNode.id)
    .find((item) => item.name === source);
  if (scopedSource) {
    return scopedSource.nodeId;
  }

  const { flows } = discoverFlows(model.nodes, model.controlFlow);
  const flow = flows.find((item) => item.nodes.some((node) => node.id === targetNode.id));
  if (flow && inputParamsFor(flow.input).some((param) => param.name === source)) {
    return flow.input.id;
  }

  return undefined;
}

function toFlowEdges(model: ModuleFlowModel): Edge[] {
  const edges: Edge[] = model.controlFlow.map((edge) => ({
    id: `control:${edge.from}->${edge.to}`,
    source: edge.from,
    sourceHandle: "control-out",
    target: edge.to,
    targetHandle: "control-in",
    type: "smoothstep",
    animated: false,
    style: {
      strokeWidth: 2.5,
      stroke: "var(--moduleflow-flowEdge)"
    },
    data: {
      kind: "control"
    }
  }));
  for (const node of model.nodes) {
    if (!hasParams(node) && node.kind !== "moduleFlowCall") {
      continue;
    }

    for (const [paramName, source] of Object.entries(node.inputMappings)) {
      const sourceNodeId = sourceNodeIdFor(model, source, node);
      if (!sourceNodeId) {
        continue;
      }

      edges.push({
        id: `data:${sourceNodeId}:${source}->${node.id}:${paramName}`,
        source: sourceNodeId,
        sourceHandle: sourceHandleFor(model, sourceNodeId, source),
        target: node.id,
        targetHandle: paramName,
        style: {
          strokeWidth: 1.6,
          stroke: "var(--moduleflow-dataEdge)"
        },
        data: {
          kind: "data",
          target: node.id,
          targetHandle: paramName
        },
        animated: false
      });
    }
  }

  for (const codeNode of model.nodes.filter((node): node is Extract<ModuleFlowNode, { kind: "code" }> => node.kind === "code")) {
    for (const dependency of codeDependencies(codeNode.code)) {
      const sourceNodeId = sourceNodeIdFor(model, dependency, codeNode);
      if (!sourceNodeId) {
        continue;
      }

      edges.push({
        id: `data:${sourceNodeId}:${dependency}->${codeNode.id}:dependency:${dependency}`,
        source: sourceNodeId,
        sourceHandle: sourceHandleFor(model, sourceNodeId, dependency),
        target: codeNode.id,
        targetHandle: `dependency:${dependency}`,
        style: {
          strokeWidth: 1.6,
          stroke: "var(--moduleflow-dataEdge)"
        },
        data: {
          kind: "data",
          target: codeNode.id,
          targetHandle: `dependency:${dependency}`
        },
        animated: false
      });
    }
  }

  return edges;
}

function functionReturnOptions(model: ModuleFlowModel | undefined, inputNode: Extract<ModuleFlowNode, { kind: "input" }>): string[] {
  if (!model) {
    return inputParamsFor(inputNode).map((param) => param.name);
  }

  const flow = discoverFlows(model.nodes, model.controlFlow).flows.find((item) => item.input.id === inputNode.id);
  const flowOutputs = flow
    ? flow.nodes.slice(1).flatMap(outputNamesForNode)
    : [];

  return uniqueOptions([
    ...inputParamsFor(inputNode).map((param) => param.name),
    ...flowOutputs
  ]);
}

function outputSources(model: ModuleFlowModel, targetNode?: ModuleFlowNode): string[] {
  if (!targetNode) {
    return [];
  }

  return previousScopedSources(model.nodes, model.controlFlow, targetNode.id);
}

function sourceHandleFor(model: ModuleFlowModel, sourceNodeId: string, source: string): string {
  const sourceNode = model.nodes.find((item) => item.id === sourceNodeId);
  if (sourceNode?.kind === "input") {
    if (source.startsWith("input.")) {
      return source.slice("input.".length);
    }

    return source;
  }

  if (sourceNode?.kind === "code") {
    return `output:${sourceNodeId}:${source}`;
  }

  return "result";
}

function sourceFromCodeHandle(sourceHandle: string | null | undefined, sourceNodeId: string): string | undefined {
  if (!sourceHandle?.startsWith("output:")) {
    return undefined;
  }

  const nodePrefix = `output:${sourceNodeId}:`;
  if (sourceHandle.startsWith(nodePrefix)) {
    return sourceHandle.slice(nodePrefix.length);
  }

  return sourceHandle.slice("output:".length);
}

function cloneModel(model: ModuleFlowModel): ModuleFlowModel {
  return JSON.parse(JSON.stringify(model)) as ModuleFlowModel;
}

function createsControlCycle(controlFlow: { from: string; to: string }[], from: string, to: string): boolean {
  const nextByFrom = new Map(controlFlow.map((edge) => [edge.from, edge.to]));
  const seen = new Set<string>([from]);
  let current = to;

  while (current) {
    if (seen.has(current)) {
      return true;
    }
    seen.add(current);
    const next = nextByFrom.get(current);
    if (!next) {
      return false;
    }
    current = next;
  }

  return false;
}

function uniqueOptions(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function flowNodeSize(node: Node<FlowNodeData>): { width: number; height: number } {
  return {
    width: node.measured?.width ?? node.width ?? 298,
    height: node.measured?.height ?? node.height ?? 220
  };
}

type ScopeNodePosition = {
  nodeId: string;
  position: { x: number; y: number };
};

type ScopeDragState = {
  startClientX: number;
  startClientY: number;
  zoom: number;
  moved: boolean;
  nodes: ScopeNodePosition[];
};

function FlowScopeOverlays({
  model,
  nodes,
  onScopeSelect,
  onScopeDrag,
  onScopeDragEnd
}: {
  model: ModuleFlowModel;
  nodes: Node<FlowNodeData>[];
  onScopeSelect: (inputId: string, additive: boolean) => void;
  onScopeDrag: (positions: ScopeNodePosition[]) => void;
  onScopeDragEnd: (positions: ScopeNodePosition[]) => void;
}) {
  const viewport = useViewport();
  const dragRef = useRef<ScopeDragState | undefined>();
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const scopes = useMemo(() => {
    return discoverFlows(model.nodes, model.controlFlow).flows.flatMap((flow) => {
      const renderedNodes = flow.nodes
        .map((node) => nodeById.get(node.id))
        .filter((node): node is Node<FlowNodeData> => Boolean(node));

      if (renderedNodes.length < 2) {
        return [];
      }

      const bounds = renderedNodes.reduce(
        (current, node) => {
          const size = flowNodeSize(node);
          return {
            minX: Math.min(current.minX, node.position.x),
            minY: Math.min(current.minY, node.position.y),
            maxX: Math.max(current.maxX, node.position.x + size.width),
            maxY: Math.max(current.maxY, node.position.y + size.height)
          };
        },
        {
          minX: Number.POSITIVE_INFINITY,
          minY: Number.POSITIVE_INFINITY,
          maxX: Number.NEGATIVE_INFINITY,
          maxY: Number.NEGATIVE_INFINITY
        }
      );
      const padding = 28;

      return [
        {
          id: flow.input.id,
          label: flow.input.functionName,
          complete: flow.complete,
          nodes: renderedNodes.map((node) => ({
            nodeId: node.id,
            position: { ...node.position }
          })),
          x: (bounds.minX - padding) * viewport.zoom + viewport.x,
          y: (bounds.minY - padding) * viewport.zoom + viewport.y,
          width: (bounds.maxX - bounds.minX + padding * 2) * viewport.zoom,
          height: (bounds.maxY - bounds.minY + padding * 2) * viewport.zoom
        }
      ];
    });
  }, [model.controlFlow, model.nodes, nodeById, viewport.x, viewport.y, viewport.zoom]);

  const dragPositions = (event: { clientX: number; clientY: number }): ScopeNodePosition[] | undefined => {
    const drag = dragRef.current;
    if (!drag) {
      return undefined;
    }

    const deltaX = (event.clientX - drag.startClientX) / drag.zoom;
    const deltaY = (event.clientY - drag.startClientY) / drag.zoom;
    if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
      drag.moved = true;
    }

    return drag.nodes.map((node) => ({
      nodeId: node.nodeId,
      position: {
        x: node.position.x + deltaX,
        y: node.position.y + deltaY
      }
    }));
  };

  return (
    <>
      <div className="scope-overlay-layer">
        {scopes.map((scope) => (
          <div
            className={`scope-overlay ${scope.complete ? "complete" : "incomplete"}`}
            key={scope.id}
            style={{
              left: scope.x,
              top: scope.y,
              width: scope.width,
              height: scope.height
            }}
          />
        ))}
      </div>
      <div className="scope-interaction-layer">
        {scopes.map((scope) => (
          <div
            className="scope-interaction-box"
            key={scope.id}
            style={{
              left: scope.x,
              top: scope.y,
              width: scope.width,
              height: scope.height
            }}
          >
            <button
              className="scope-label"
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onScopeSelect(scope.id, event.shiftKey);
                dragRef.current = {
                  startClientX: event.clientX,
                  startClientY: event.clientY,
                  zoom: viewport.zoom,
                  moved: false,
                  nodes: scope.nodes
                };

                const onMove = (moveEvent: PointerEvent) => {
                  const positions = dragPositions(moveEvent);
                  if (positions) {
                    onScopeDrag(positions);
                  }
                };
                const onEnd = (endEvent: PointerEvent) => {
                  const drag = dragRef.current;
                  const positions = dragPositions(endEvent);
                  dragRef.current = undefined;
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onEnd);
                  window.removeEventListener("pointercancel", onEnd);
                  if (positions && drag?.moved) {
                    onScopeDragEnd(positions);
                  }
                };

                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onEnd);
                window.addEventListener("pointercancel", onEnd);
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {scope.label}
            </button>
            {["top", "right", "bottom", "left"].map((side) => (
              <button
                aria-label={`Select ${scope.label} flow`}
                className={`scope-select-zone ${side}`}
                key={side}
                type="button"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onScopeSelect(scope.id, event.shiftKey);
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function SourceSelect({
  value,
  options,
  labels,
  onChange
}: {
  value: string;
  options: string[];
  labels?: Record<string, string>;
  onChange: (source: string) => void;
}) {
  const selectOptions = uniqueOptions([value, ...options]);

  return (
    <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
      {selectOptions.map((option) => (
        <option value={option} key={option}>
          {labels?.[option] ?? option}
        </option>
      ))}
    </select>
  );
}

function renderMarkdown(markdown: string): React.ReactNode {
  const lines = markdown.trim() ? markdown.split(/\r?\n/) : ["Click to edit markdown"];
  const rendered: React.ReactNode[] = [];
  let listItems: string[] = [];
  let codeLines: string[] = [];
  let inCode = false;

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }
    rendered.push(
      <ul key={`list-${rendered.length}`}>
        {listItems.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    );
    listItems = [];
  };

  const flushCode = () => {
    if (codeLines.length === 0) {
      return;
    }
    rendered.push(<pre key={`code-${rendered.length}`}><code>{codeLines.join("\n")}</code></pre>);
    codeLines = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
      } else {
        flushList();
      }
      inCode = !inCode;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      rendered.push(<Tag key={`heading-${rendered.length}`}>{heading[2]}</Tag>);
      continue;
    }

    const listItem = /^[*-]\s+(.+)$/.exec(line);
    if (listItem) {
      listItems.push(listItem[1]);
      continue;
    }

    flushList();
    if (line.trim()) {
      rendered.push(<p key={`paragraph-${rendered.length}`}>{line}</p>);
    }
  }

  flushList();
  flushCode();
  return rendered;
}

function CodeEditor({
  value,
  onChange,
  onCommit
}: {
  value: string;
  onChange: (code: string) => void;
  onCommit: (code: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latestValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  const commitTimerRef = useRef<number | undefined>();

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
    onCommitRef.current = onCommit;
  }, [onChange, onCommit]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          highlightSpecialChars(),
          history(),
          javascript(),
          closeBrackets(),
          bracketMatching(),
          indentOnInput(),
          syntaxHighlighting(moduleFlowHighlightStyle),
          drawSelection(),
          EditorView.lineWrapping,
          keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) {
              return;
            }

            const nextValue = update.state.doc.toString();
            latestValueRef.current = nextValue;
            onChangeRef.current(nextValue);

            if (commitTimerRef.current) {
              window.clearTimeout(commitTimerRef.current);
            }
            commitTimerRef.current = window.setTimeout(() => onCommitRef.current(latestValueRef.current), 400);
          }),
          EditorView.theme({
            "&": {
              backgroundColor: "transparent"
            }
          })
        ]
      })
    });

    viewRef.current = view;
    return () => {
      if (commitTimerRef.current) {
        window.clearTimeout(commitTimerRef.current);
        onCommitRef.current(latestValueRef.current);
      }
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();
    if (value !== currentValue) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentValue.length,
          insert: value
        }
      });
    }
  }, [value]);

  return (
    <div
      className="code-editor nodrag nopan"
      ref={hostRef}
      onBlur={() => onCommitRef.current(latestValueRef.current)}
      onClickCapture={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onMouseDownCapture={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDownCapture={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

function nodeTitle(node: ModuleFlowNode): string {
  if (node.kind === "input") {
    return node.functionName;
  }

  if (hasVariable(node)) {
    return node.variableName;
  }

  if (node.kind === "code") {
    return "code";
  }

  return "";
}

function nodeDetail(node: ModuleFlowNode, model?: ModuleFlowModel): string {
  if (node.kind === "call") {
    return `${node.callName ?? node.exportName}(${node.params.map((param) => param.name).join(", ")})`;
  }

  if (node.kind === "moduleFlowCall") {
    const params = moduleFlowCallParams(model, node).map((param) => param.name).join(", ");
    return `${moduleFlowFunctionFor(model, node.functionNodeId)?.functionName ?? "missingFunction"}(${params})`;
  }

  if (node.kind === "classInstance") {
    return `new ${node.callName ?? node.exportName}(${node.params.map((param) => param.name).join(", ")})`;
  }

  if (node.kind === "methodCall") {
    return `${node.instanceVariableName}.${node.methodName}(${node.params.map((param) => param.name).join(", ")})`;
  }

  if (node.kind === "input") {
    return `input (${inputParamsFor(node).map((param) => param.name).join(", ")})`;
  }

  if (node.kind === "code") {
    return "code";
  }

  return "";
}

const ModuleFlowCard = memo(({ data }: NodeProps<Node<FlowNodeData>>) => {
  const { model, node: selectedNode, onModelChange, sources } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  const [editingMarkdown, setEditingMarkdown] = useState(false);
  const [codePropertiesOpen, setCodePropertiesOpen] = useState(false);

  useEffect(() => {
    if (selectedNode.kind !== "code") {
      return;
    }

    const frame = window.requestAnimationFrame(() => updateNodeInternals(selectedNode.id));
    return () => window.cancelAnimationFrame(frame);
  }, [codePropertiesOpen, selectedNode.id, selectedNode.kind, selectedNode.kind === "code" ? selectedNode.code : undefined, updateNodeInternals]);

  const renameOutput = (nextName: string) => {
    if (!hasVariable(selectedNode) || !nextName || nextName === selectedNode.variableName) {
      return;
    }

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node && hasVariable(node)) {
      const oldName = node.variableName;
      node.variableName = nextName;
      for (const candidate of nextModel.nodes) {
        if (hasInputMappings(candidate)) {
          for (const [inputName, source] of Object.entries(candidate.inputMappings)) {
            if (source === oldName) {
              candidate.inputMappings[inputName] = nextName;
            }
          }
        }
        if (candidate.kind === "methodCall" && candidate.instanceVariableName === oldName) {
          candidate.instanceVariableName = nextName;
          candidate.label = `${nextName}.${candidate.methodName}`;
        }
        if (candidate.kind === "input" && candidate.returnSource === oldName) {
          candidate.returnSource = nextName;
        }
      }
        onModelChange(nextModel);
      }
    }

    vscode.postMessage({
      type: "renameVariable",
      nodeId: selectedNode.id,
      variableName: nextName
    });
  };

  const renameFunction = (nextName: string) => {
    if (selectedNode.kind !== "input" || !nextName || nextName === selectedNode.functionName) {
      return;
    }

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node?.kind === "input") {
        node.functionName = nextName;
        onModelChange(nextModel);
      }
    }

    vscode.postMessage({
      type: "renameFunction",
      nodeId: selectedNode.id,
      functionName: nextName
    });
  };

  const renameCodeNode = (nextLabel: string) => {
    if (selectedNode.kind !== "code") {
      return;
    }

    const label = nextLabel.trim() || "code";
    if (label === selectedNode.label) {
      return;
    }

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node?.kind === "code") {
        node.label = label;
        onModelChange(nextModel);
      }
    }

    vscode.postMessage({
      type: "renameCodeNode",
      nodeId: selectedNode.id,
      label
    });
  };

  const updateInputSource = (paramName: string, source: string) => {
    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node && hasInputMappings(node)) {
        node.inputMappings[paramName] = source;
        onModelChange(nextModel);
      }
    }

    vscode.postMessage({
      type: "setInputExpression",
      nodeId: selectedNode.id,
      paramName,
      source
    });
  };

  const updateModuleFlowFunction = (functionNodeId: string) => {
    if (selectedNode.kind !== "moduleFlowCall") {
      return;
    }

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      const inputNode = nextModel.nodes.find((item): item is Extract<ModuleFlowNode, { kind: "input" }> =>
        item.kind === "input" && item.id === functionNodeId
      );
      if (node?.kind === "moduleFlowCall" && inputNode) {
        const previousMappings = node.inputMappings;
        node.functionNodeId = functionNodeId;
        node.label = inputNode.functionName;
        node.inputMappings = Object.fromEntries(
          inputParamsFor(inputNode).map((param) => [param.name, previousMappings[param.name] ?? param.name])
        );
        onModelChange(nextModel);
      }
    }

    vscode.postMessage({
      type: "setModuleFlowCallFunction",
      nodeId: selectedNode.id,
      functionNodeId
    });
  };

  const updateFunctionReturnSource = (source: string) => {
    if (selectedNode.kind !== "input") {
      return;
    }

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node?.kind === "input") {
        node.returnSource = source || undefined;
        onModelChange(nextModel);
      }
    }

    vscode.postMessage({
      type: "setFunctionReturn",
      nodeId: selectedNode.id,
      source
    });
  };

  const updateDescription = (description: string) => {
    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node) {
        node.description = description || undefined;
        onModelChange(nextModel);
      }
    }

    vscode.postMessage({
      type: "updateDescription",
      nodeId: selectedNode.id,
      description
    });
  };

  const updateFunctionInputsLocal = (params: ExportParameter[], options: { commit?: boolean } = {}) => {
    if (selectedNode.kind !== "input") {
      return;
    }

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const inputNode = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (inputNode?.kind === "input") {
        inputNode.params = params;
        if (params.length > 0) {
          inputNode.execute = undefined;
        }
        onModelChange(nextModel);
      }
    }

    if (options.commit === false) {
      return;
    }

    vscode.postMessage({
      type: "updateFunctionInputs",
      nodeId: selectedNode.id,
      params
    });
  };

  const updateFunctionExecuteLocal = (execute: boolean) => {
    if (selectedNode.kind !== "input" || inputParamsFor(selectedNode).length > 0) {
      return;
    }

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      for (const node of nextModel.nodes) {
        if (node.kind === "input") {
          node.execute = node.id === selectedNode.id && execute ? true : undefined;
        }
      }
      onModelChange(nextModel);
    }

    vscode.postMessage({
      type: "updateFunctionExecute",
      nodeId: selectedNode.id,
      execute
    });
  };

  const updateCodeLocal = (code: string) => {
    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node?.kind === "code") {
        node.code = code;
        onModelChange(nextModel);
        window.requestAnimationFrame(() => updateNodeInternals(selectedNode.id));
      }
    }
  };

  const commitCode = (code: string) => {
    vscode.postMessage({
      type: "updateCode",
      nodeId: selectedNode.id,
      code
    });
  };

  const updateMarkdownLocal = (markdown: string) => {
    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node?.kind === "markdown") {
        node.markdown = markdown;
        onModelChange(nextModel);
      }
    }
  };

  const commitMarkdown = (markdown: string) => {
    vscode.postMessage({
      type: "updateMarkdown",
      nodeId: selectedNode.id,
      markdown
    });
  };

  const updateMarkdownParentLocal = (parentNodeId: string) => {
    if (selectedNode.kind !== "markdown") {
      return;
    }

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node?.kind === "markdown") {
        node.parentNodeId = parentNodeId || undefined;
        onModelChange(nextModel);
      }
    }

    vscode.postMessage({
      type: "updateMarkdownParent",
      nodeId: selectedNode.id,
      parentNodeId
    });
  };

  const resizeMarkdown = (size: { width: number; height: number }) => {
    if (selectedNode.kind !== "markdown") {
      return;
    }

    const nextSize = {
      width: Math.max(220, Math.round(size.width)),
      height: Math.max(140, Math.round(size.height))
    };

    if (model && onModelChange) {
      const nextModel = cloneModel(model);
      const node = nextModel.nodes.find((item) => item.id === selectedNode.id);
      if (node?.kind === "markdown") {
        node.size = nextSize;
        onModelChange(nextModel);
        window.requestAnimationFrame(() => updateNodeInternals(selectedNode.id));
      }
    }
  };

  const commitMarkdownSize = (size: { width: number; height: number }) => {
    vscode.postMessage({
      type: "updateNodeSize",
      nodeId: selectedNode.id,
      size
    });
  };

  if (selectedNode.kind === "markdown") {
    const size = markdownNodeSize(selectedNode);
    const parentOptions = model?.nodes.filter((node): node is Extract<ModuleFlowNode, { kind: "input" }> =>
      node.kind === "input"
    ) ?? [];

    return (
      <div className="node-card node-card-markdown" style={{ width: size.width, height: size.height }}>
        {editingMarkdown ? (
          <textarea
            autoFocus
            className="markdown-editor nodrag nopan"
            value={selectedNode.markdown}
            onBlur={() => {
              setEditingMarkdown(false);
              commitMarkdown(selectedNode.markdown);
            }}
            onChange={(event) => updateMarkdownLocal(event.currentTarget.value)}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          />
        ) : (
          <div
            className={`markdown-preview ${selectedNode.markdown.trim() ? "" : "empty"}`}
            onClick={(event) => {
              event.stopPropagation();
              setEditingMarkdown(true);
            }}
          >
            {renderMarkdown(selectedNode.markdown)}
          </div>
        )}

        <details className="node-properties markdown-properties nodrag">
          <summary>Properties</summary>
          <label>
            Parent node
            <select
              value={selectedNode.parentNodeId ?? ""}
              onChange={(event) => updateMarkdownParentLocal(event.currentTarget.value)}
            >
              <option value="">none</option>
              {parentOptions.map((node) => (
                <option value={node.id} key={node.id}>
                  {nodeTitle(node)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="action-button"
            onClick={() =>
              vscode.postMessage({
                type: "duplicateNode",
                nodeId: selectedNode.id
              })
            }
          >
            Duplicate node
          </button>
          <button
            className="action-button danger"
            onClick={() =>
              vscode.postMessage({
                type: "deleteNode",
                nodeId: selectedNode.id
              })
            }
          >
            Delete node
          </button>
        </details>

        <div
          className="markdown-resize-handle nodrag nopan"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const startX = event.clientX;
            const startY = event.clientY;
            const startSize = markdownNodeSize(selectedNode);
            let latestSize = startSize;

            const onMove = (moveEvent: PointerEvent) => {
              latestSize = {
                width: startSize.width + moveEvent.clientX - startX,
                height: startSize.height + moveEvent.clientY - startY
              };
              resizeMarkdown(latestSize);
            };
            const onEnd = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onEnd);
              window.removeEventListener("pointercancel", onEnd);
              const committedSize = {
                width: Math.max(220, Math.round(latestSize.width)),
                height: Math.max(140, Math.round(latestSize.height))
              };
              commitMarkdownSize(committedSize);
            };

            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onEnd);
            window.addEventListener("pointercancel", onEnd);
          }}
        />
      </div>
    );
  }

  const inputRows = hasParams(selectedNode)
      ? selectedNode.params.map((param) => ({ id: param.name, label: param.name }))
      : selectedNode.kind === "moduleFlowCall"
        ? moduleFlowCallParams(model, selectedNode).map((param) => ({ id: param.name, label: param.name }))
        : selectedNode.kind === "code"
          ? codeDependencies(selectedNode.code).map((name) => ({ id: `dependency:${name}`, label: name }))
        : [];
  const outputRows = selectedNode.kind === "input"
    ? inputParamsFor(selectedNode).map((param) => ({ id: param.name, label: param.name }))
    : hasVariable(selectedNode)
      ? [{ id: "result", label: "return" }]
      : selectedNode.kind === "code"
        ? codeOutputs(selectedNode.code).map((name) => ({ id: `output:${selectedNode.id}:${name}`, label: name }))
        : [];
  const flowInputNode = model
    ? discoverFlows(model.nodes, model.controlFlow).flows.find((flow) => flow.nodes.some((node) => node.id === selectedNode.id))?.input
    : undefined;
  const scopedInputOptions = inputParamsFor(flowInputNode).map((param) => param.name);
  const cardStyle: React.CSSProperties | undefined = selectedNode.kind === "code" && codePropertiesOpen
    ? { width: codeNodeWidth(selectedNode.code) }
    : undefined;

  return (
    <div className={`node-card node-card-${selectedNode.kind}`} style={cardStyle}>
      {!hasVariable(selectedNode) && !["input", "code"].includes(selectedNode.kind) && (
        <div className="node-title-label">{selectedNode.kind}</div>
      )}
      {hasVariable(selectedNode) ? (
        <input
          className="node-title-input nodrag"
          value={selectedNode.variableName}
          onChange={(event) => renameOutput(event.currentTarget.value.trim())}
        />
      ) : selectedNode.kind === "input" ? (
        <input
          className="node-title-input nodrag"
          value={selectedNode.functionName}
          onChange={(event) => renameFunction(event.currentTarget.value.trim())}
        />
      ) : selectedNode.kind === "code" ? (
        <input
          className="node-title-input nodrag"
          value={selectedNode.label}
          onChange={(event) => renameCodeNode(event.currentTarget.value)}
        />
      ) : (
        <div className="node-title">{nodeTitle(selectedNode)}</div>
      )}
      <div className="node-detail">{nodeDetail(selectedNode, model)}</div>
      {selectedNode.warning && <div className="node-warning">{selectedNode.warning}</div>}

      <details
        className="node-properties nodrag"
        onToggle={(event) => {
          if (selectedNode.kind === "code") {
            setCodePropertiesOpen(event.currentTarget.open);
          }
        }}
      >
        <summary>Properties</summary>

        {selectedNode.kind === "code" && (
          <>
            <h3>Code</h3>
            <CodeEditor
              value={selectedNode.code}
              onChange={updateCodeLocal}
              onCommit={commitCode}
            />
          </>
        )}

        <label>
          Description
          <textarea
            value={selectedNode.description ?? ""}
            rows={3}
            onChange={(event) => updateDescription(event.currentTarget.value)}
          />
        </label>

        {hasParams(selectedNode) && (
          <>
            <h3>Inputs</h3>
            {selectedNode.params.map((param) => (
              <label key={param.name}>
                {param.name}
                <SourceSelect
                  value={selectedNode.inputMappings[param.name] ?? param.name}
                  options={[param.name, `input.${param.name}`, ...sources]}
                  onChange={(source) => updateInputSource(param.name, source)}
                />
              </label>
            ))}
          </>
        )}

        {selectedNode.kind === "input" && (
          <>
            <h3>Function inputs</h3>
            <div className="function-input-list">
              {inputParamsFor(selectedNode).map((param, index, params) => (
                <div className="function-input-row" key={index}>
                  <input
                    aria-label={`Input ${index + 1} name`}
                    value={param.name}
                    onChange={(event) => {
                      const nextParams = params.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name: event.currentTarget.value } : item
                      );
                      updateFunctionInputsLocal(nextParams, { commit: false });
                    }}
                    onBlur={() => updateFunctionInputsLocal(inputParamsFor(selectedNode))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  <button
                    className="mini-action-button"
                    disabled={index === 0}
                    onClick={() => {
                      const nextParams = [...params];
                      [nextParams[index - 1], nextParams[index]] = [nextParams[index], nextParams[index - 1]];
                      updateFunctionInputsLocal(nextParams);
                    }}
                    type="button"
                  >
                    Up
                  </button>
                  <button
                    className="mini-action-button"
                    disabled={index === params.length - 1}
                    onClick={() => {
                      const nextParams = [...params];
                      [nextParams[index], nextParams[index + 1]] = [nextParams[index + 1], nextParams[index]];
                      updateFunctionInputsLocal(nextParams);
                    }}
                    type="button"
                  >
                    Down
                  </button>
                  <button
                    className="mini-action-button danger"
                    onClick={() => updateFunctionInputsLocal(params.filter((_item, itemIndex) => itemIndex !== index))}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
            <button
              className="action-button"
              onClick={() => {
                const existingNames = new Set(inputParamsFor(selectedNode).map((param) => param.name));
                let nextName = "input";
                let suffix = 2;
                while (existingNames.has(nextName)) {
                  nextName = `input${suffix}`;
                  suffix += 1;
                }
                updateFunctionInputsLocal([...inputParamsFor(selectedNode), { name: nextName, required: true }]);
              }}
              type="button"
            >
              + Input
            </button>
            <label>
              Return
              <SourceSelect
                value={selectedNode.returnSource ?? ""}
                options={["", ...functionReturnOptions(model, selectedNode)]}
                labels={{ "": "none" }}
                onChange={updateFunctionReturnSource}
              />
            </label>
            {inputParamsFor(selectedNode).length === 0 && (
              <label className="checkbox-label">
                <input
                  checked={Boolean(selectedNode.execute)}
                  onChange={(event) => updateFunctionExecuteLocal(event.currentTarget.checked)}
                  type="checkbox"
                />
                Execute
              </label>
            )}
          </>
        )}

        {selectedNode.kind === "moduleFlowCall" && (
          <>
            <label>
              Function
              <select
                value={selectedNode.functionNodeId}
                onChange={(event) => updateModuleFlowFunction(event.currentTarget.value)}
              >
                {model && moduleFlowFunctions(model).map((inputNode) => (
                  <option value={inputNode.id} key={inputNode.id}>
                    {inputNode.functionName}
                  </option>
                ))}
              </select>
            </label>
            <h3>Inputs</h3>
            {moduleFlowCallParams(model, selectedNode).map((param) => (
              <label key={param.name}>
                {param.name}
                <SourceSelect
                  value={selectedNode.inputMappings[param.name] ?? param.name}
                  options={[param.name, ...sources]}
                  onChange={(source) => updateInputSource(param.name, source)}
                />
              </label>
            ))}
          </>
        )}

        {selectedNode.kind === "input" && (
          <button
            className="action-button danger"
            onClick={() => {
              vscode.postMessage({
                type: "deleteFunction",
                inputNodeId: selectedNode.id
              });
            }}
          >
            Delete function
          </button>
        )}

        {selectedNode.kind !== "input" && (
          <>
            <button
              className="action-button"
              onClick={() =>
                vscode.postMessage({
                  type: "duplicateNode",
                  nodeId: selectedNode.id
                })
              }
            >
              Duplicate node
            </button>
            <button
              className="action-button danger"
              onClick={() =>
                vscode.postMessage({
                  type: "deleteNode",
                  nodeId: selectedNode.id
                })
              }
            >
              Delete node
            </button>
          </>
        )}
      </details>

      {(inputRows.length > 0 || outputRows.length > 0) && (
        <div className="node-section io-section">
          <div className="io-inputs">
            {inputRows.length > 0 && (
              <>
                <div className="section-label">Inputs</div>
                {inputRows.map((input) => (
                  <div className="input-row" key={input.id}>
                    <Handle id={input.id} type="target" position={Position.Left} className="input-handle" />
                    <span>{input.label}</span>
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="io-outputs">
            {outputRows.length > 0 && selectedNode.kind === "code" && <div className="section-label">Outputs</div>}
            {outputRows.map((output) => (
              <div className="output-row" key={output.id}>
                <span>{output.label}</span>
                <Handle id={output.id} type="source" position={Position.Right} className="output-handle" />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="node-section flow-section">
        <span>Flow</span>
        {selectedNode.kind !== "input" && (
          <Handle id="control-in" type="target" position={Position.Left} className="control-handle control-in-handle" />
        )}
        <Handle id="control-out" type="source" position={Position.Right} className="control-handle control-out-handle" />
      </div>
    </div>
  );
});

function Inspector({
  selectedEdge
}: {
  selectedEdge?: Edge;
}) {
  if (selectedEdge) {
    return (
      <aside className="inspector">
        <h2>Edge</h2>
        <div className="muted">{selectedEdge.source} {"->"} {selectedEdge.target}</div>
        <button
          className="action-button danger"
          onClick={() =>
              vscode.postMessage({
                type: "deleteEdge",
                source: selectedEdge.source,
                target: selectedEdge.target,
                targetHandle: selectedEdge.targetHandle
              })
          }
        >
          Delete edge
        </button>
      </aside>
    );
  }

  return null;
}


function Toolbox({
  model
}: {
  model: ModuleFlowModel;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const startDrag = (event: React.DragEvent, payload: ToolDragPayload) => {
    event.dataTransfer.setData("application/moduleflow", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
  };

  if (collapsed) {
    return (
      <aside className="toolbox collapsed">
        <button
          aria-label="Show tools"
          className="toolbox-toggle"
          onClick={() => setCollapsed(false)}
          type="button"
        >
          Tools
        </button>
      </aside>
    );
  }

  return (
    <aside className="toolbox">
      <div className="toolbox-header">
        <h2>Tools</h2>
        <button
          aria-label="Hide tools"
          className="toolbox-collapse-button"
          onClick={() => setCollapsed(true)}
          type="button"
        >
          Hide
        </button>
      </div>
      <button className="action-button primary" onClick={() => vscode.postMessage({ type: "importTools" })}>Import tools</button>
      <button className="action-button" onClick={() => vscode.postMessage({ type: "addFunction" })}>+ Function</button>
      <button className="action-button" onClick={() => vscode.postMessage({ type: "addCodeNode" })}>+ Code</button>
      <button
        className="action-button"
        draggable
        onDragStart={(event) => startDrag(event, { type: "addMarkdownNode" })}
        onClick={() => vscode.postMessage({ type: "addMarkdownNode" })}
      >
        + Markdown
      </button>
      <button className="action-button" onClick={() => vscode.postMessage({ type: "refresh" })}>Refresh files</button>
      {moduleFlowFunctions(model).length > 0 && (
        <details open>
          <summary>ModuleFlow</summary>
          {moduleFlowFunctions(model).map((inputNode) => (
            <button
              className="tool-button"
              draggable
              key={inputNode.id}
              onDragStart={(event) =>
                startDrag(event, {
                  type: "addModuleFlowCall",
                  functionNodeId: inputNode.id
                })
              }
              onClick={() =>
                vscode.postMessage({
                  type: "addModuleFlowCall",
                  functionNodeId: inputNode.id
                })
              }
            >
              + {inputNode.functionName}(input)
            </button>
          ))}
        </details>
      )}
      {model.imports.map((toolModule) => (
        <details key={toolModule.modulePath} open>
          <summary>{toolModule.fileName}</summary>
          {toolModule.exports.map((item) => (
            <div key={item.name}>
              <button
                className="tool-button"
                draggable
                onDragStart={(event) =>
                  startDrag(event, {
                    type: "addNode",
                    modulePath: toolModule.modulePath,
                    exportName: item.name,
                    methodName: null
                  })
                }
                onClick={() =>
                  vscode.postMessage({
                    type: "addNode",
                    modulePath: toolModule.modulePath,
                    exportName: item.name,
                    methodName: null
                  })
                }
              >
                + {item.kind === "class" ? `${item.name} class` : `${item.name}(${item.params.map((param) => param.name).join(", ")})`}
              </button>
              {item.kind === "class" &&
                item.methods.map((method) => (
                  <button
                    className="tool-button child"
                    key={method.name}
                    draggable
                    onDragStart={(event) =>
                      startDrag(event, {
                        type: "addNode",
                        modulePath: toolModule.modulePath,
                        exportName: item.name,
                        methodName: method.name
                      })
                    }
                    onClick={() =>
                      vscode.postMessage({
                        type: "addNode",
                        modulePath: toolModule.modulePath,
                        exportName: item.name,
                        methodName: method.name
                      })
                    }
                  >
                    + {item.name}.{method.name}({method.params.map((param) => param.name).join(", ")})
                  </button>
                ))}
            </div>
          ))}
        </details>
      ))}
    </aside>
  );
}

function CanvasContextMenu({
  model,
  menu,
  onAdd,
  onClose
}: {
  model: ModuleFlowModel;
  menu: CanvasContextMenuState;
  onAdd: (payload: ToolDragPayload) => void;
  onClose: () => void;
}) {
  const addAndClose = (payload: ToolDragPayload) => {
    onAdd(payload);
    onClose();
  };

  return (
    <div
      className="canvas-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="context-menu-title">Add node</div>
      <button type="button" onClick={() => addAndClose({ type: "addFunction" })}>Function</button>
      <button type="button" onClick={() => addAndClose({ type: "addCodeNode" })}>Code</button>
      <button type="button" onClick={() => addAndClose({ type: "addMarkdownNode" })}>Markdown</button>

      {moduleFlowFunctions(model).length > 0 && (
        <>
          <div className="context-menu-divider" />
          <div className="context-menu-title">ModuleFlow</div>
          {moduleFlowFunctions(model).map((inputNode) => (
            <button
              key={inputNode.id}
              type="button"
              onClick={() => addAndClose({ type: "addModuleFlowCall", functionNodeId: inputNode.id })}
            >
              {inputNode.functionName}(input)
            </button>
          ))}
        </>
      )}

      {model.imports.length > 0 && (
        <>
          <div className="context-menu-divider" />
          {model.imports.map((toolModule) => (
            <div key={toolModule.modulePath}>
              <div className="context-menu-title">{toolModule.fileName}</div>
              {toolModule.exports.map((item) => (
                <div key={item.name}>
                  <button
                    type="button"
                    onClick={() =>
                      addAndClose({
                        type: "addNode",
                        modulePath: toolModule.modulePath,
                        exportName: item.name,
                        methodName: null
                      })
                    }
                  >
                    {item.kind === "class" ? `${item.name} class` : `${item.name}(${item.params.map((param) => param.name).join(", ")})`}
                  </button>
                  {item.kind === "class" && item.methods.map((method) => (
                    <button
                      className="child"
                      key={method.name}
                      type="button"
                      onClick={() =>
                        addAndClose({
                          type: "addNode",
                          modulePath: toolModule.modulePath,
                          exportName: item.name,
                          methodName: method.name
                        })
                      }
                    >
                      {item.name}.{method.name}({method.params.map((param) => param.name).join(", ")})
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function App() {
  const parsedModel = JSON.parse(document.getElementById("moduleflow-data")?.textContent ?? "{}") as ModuleFlowModel;
  const [model, setModel] = useState(parsedModel);
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(model));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(model));
  const [selectedEdge, setSelectedEdge] = useState<Edge | undefined>();
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState | undefined>();
  const nodeTypes = useMemo(() => ({ moduleFlow: ModuleFlowCard }), []);
  const { screenToFlowPosition } = useReactFlow();

  const applyModel = useCallback(
    (nextModel: ModuleFlowModel) => {
      setModel(nextModel);
      setNodes((currentNodes) => mergeFlowNodes(currentNodes, nextModel, applyModel));
      setEdges(toFlowEdges(nextModel));
    },
    [setEdges, setNodes]
  );


  useEffect(() => {
    setNodes(toFlowNodes(model, applyModel));
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === "modelUpdated") {
        applyModel(event.data.model as ModuleFlowModel);
      }
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [applyModel]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || !connection.targetHandle) {
        return;
      }

      if (connection.sourceHandle === "control-out" && connection.targetHandle === "control-in") {
        if (connection.source === connection.target) {
          return;
        }

        const nextControlFlow = model.controlFlow.filter((edge) => edge.from !== connection.source && edge.to !== connection.target);
        nextControlFlow.push({ from: connection.source, to: connection.target });
        if (createsControlCycle(nextControlFlow, connection.source, connection.target)) {
          return;
        }
        const discovery = discoverFlows(model.nodes, nextControlFlow);
        if (discovery.flows.some((flow) => flow.errors.includes("shared-node"))) {
          return;
        }

        applyModel({
          ...cloneModel(model),
          controlFlow: nextControlFlow
        });

        vscode.postMessage({
          type: "updateControlFlow",
          from: connection.source,
          to: connection.target
        });
        return;
      }

      if (connection.sourceHandle === "control-out" || connection.targetHandle === "control-in") {
        return;
      }

      const sourceNode = model.nodes.find((node) => node.id === connection.source);
      const targetNode = model.nodes.find((node) => node.id === connection.target);
      if (!sourceNode || !targetNode) {
        return;
      }
      if (targetNode.kind === "code" && connection.targetHandle.startsWith("dependency:")) {
        return;
      }
      if (!canUseSource(model, sourceNode, targetNode)) {
        return;
      }

      const source = sourceNode.kind === "input"
        ? connection.sourceHandle ?? "input"
        : hasVariable(sourceNode)
          ? sourceNode.variableName
          : sourceNode.kind === "code"
            ? sourceFromCodeHandle(connection.sourceHandle, sourceNode.id)
            : undefined;

      if (!source) {
        return;
      }
      if (!source.startsWith("input") && !canUseSource(model, sourceNode, targetNode)) {
        return;
      }

      const nextModel = cloneModel(model);
      const nextTargetNode = nextModel.nodes.find((node) => node.id === connection.target);
      if (nextTargetNode && hasInputMappings(nextTargetNode)) {
        nextTargetNode.inputMappings[connection.targetHandle] = source;
      }
      applyModel(nextModel);

      vscode.postMessage({
        type: "mapInput",
        nodeId: connection.target,
        paramName: connection.targetHandle,
        source
      });
    },
    [applyModel, model]
  );

  const onNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: Node) => {
    const positions = positionsWithAttachedMarkdown(model, [{ nodeId: node.id, position: node.position }]);
    const nextPositionById = new Map(positions.map((item) => [item.nodeId, item.position]));
    setNodes((currentNodes) =>
      currentNodes.map((currentNode) => ({
        ...currentNode,
        position: nextPositionById.get(currentNode.id) ?? currentNode.position
      }))
    );
    const nextModel = cloneModel(model);
    for (const modelNode of nextModel.nodes) {
      const position = nextPositionById.get(modelNode.id);
      if (position) {
        modelNode.position = position;
      }
    }
    setModel(nextModel);

    vscode.postMessage({
      type: "updatePositions",
      positions
    });
  }, [model, setNodes]);

  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: { nodes: Node[]; edges: Edge[] }) => {
    setSelectedNodeIds(selectedNodes.map((node) => node.id));
    setSelectedEdge(selectedEdges[0]);
  }, []);

  const onScopeSelect = useCallback((inputId: string, additive: boolean) => {
    const flow = discoverFlows(model.nodes, model.controlFlow).flows.find((item) => item.input.id === inputId);
    if (!flow) {
      return;
    }

    const selectedIds = new Set(flow.nodes.map((node) => node.id));
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        selected: additive ? Boolean(node.selected || selectedIds.has(node.id)) : selectedIds.has(node.id)
      }))
    );
    setEdges((currentEdges) => currentEdges.map((edge) => ({ ...edge, selected: false })));
    setSelectedNodeIds((currentIds) =>
      additive ? Array.from(new Set([...currentIds, ...selectedIds])) : Array.from(selectedIds)
    );
    setSelectedEdge(undefined);
  }, [model.controlFlow, model.nodes, setEdges, setNodes]);

  const onScopeDrag = useCallback((positions: ScopeNodePosition[]) => {
    const expandedPositions = positionsWithAttachedMarkdown(model, positions);
    const nextPositionById = new Map(expandedPositions.map((item) => [item.nodeId, item.position]));
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        position: nextPositionById.get(node.id) ?? node.position
      }))
    );
  }, [model, setNodes]);

  const onScopeDragEnd = useCallback((positions: ScopeNodePosition[]) => {
    const expandedPositions = positionsWithAttachedMarkdown(model, positions);
    const nextPositionById = new Map(expandedPositions.map((item) => [item.nodeId, item.position]));
    const nextModel = cloneModel(model);
    for (const node of nextModel.nodes) {
      const position = nextPositionById.get(node.id);
      if (position) {
        node.position = position;
      }
    }
    setModel(nextModel);

    vscode.postMessage({
      type: "updatePositions",
      positions: expandedPositions
    });
  }, [model]);

  const onNodesDelete = useCallback((deletedNodes: Node[]) => {
    for (const node of deletedNodes) {
      vscode.postMessage({
        type: "deleteNode",
        nodeId: node.id
      });
    }
  }, []);

  const onEdgesDelete = useCallback((deletedEdges: Edge[]) => {
    for (const edge of deletedEdges) {
      vscode.postMessage({
        type: "deleteEdge",
        source: edge.source,
        target: edge.target,
        targetHandle: edge.targetHandle
      });
    }
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && canvasContextMenu) {
        setCanvasContextMenu(undefined);
        return;
      }

      const duplicateShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d";
      if (duplicateShortcut) {
        if (isEditableElement(event.target)) {
          return;
        }

        const selectedNodes = nodes.filter((node) => selectedNodeIds.includes(node.id));
        if (selectedNodes.length === 0) {
          return;
        }

        event.preventDefault();
        for (const node of selectedNodes) {
          vscode.postMessage({
            type: "duplicateNode",
            nodeId: node.id
          });
        }
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }
      if (isEditableElement(event.target)) {
        return;
      }

      const selectedNodes = nodes.filter((node) => selectedNodeIds.includes(node.id));
      const selectedEdges = selectedEdge ? [selectedEdge] : [];
      if (selectedNodes.length === 0 && selectedEdges.length === 0) {
        return;
      }

      event.preventDefault();
      onNodesDelete(selectedNodes);
      onEdgesDelete(selectedEdges);
    };

    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [canvasContextMenu, nodes, onEdgesDelete, onNodesDelete, selectedEdge, selectedNodeIds]);

  const addNodeAtContextMenu = useCallback((payload: ToolDragPayload) => {
    if (!canvasContextMenu) {
      return;
    }

    vscode.postMessage({
      ...payload,
      position: canvasContextMenu.position
    });
  }, [canvasContextMenu]);

  const onPaneContextMenu = useCallback((event: MouseEvent | React.MouseEvent) => {
    event.preventDefault();
    setCanvasContextMenu({
      x: event.clientX,
      y: event.clientY,
      position: screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      })
    });
  }, [screenToFlowPosition]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const rawPayload = event.dataTransfer.getData("application/moduleflow");
      if (!rawPayload) {
        return;
      }

      const payload = JSON.parse(rawPayload) as ToolDragPayload;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      });

      vscode.postMessage({
        ...payload,
        position
      });
    },
    [screenToFlowPosition]
  );

  return (
    <div className="shell">
      <Toolbox model={model} />
      <main className="flow-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          deleteKeyCode={["Backspace", "Delete"]}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onPaneClick={() => setCanvasContextMenu(undefined)}
          onPaneContextMenu={onPaneContextMenu}
        >
          <Background />
          <FlowScopeOverlays
            model={model}
            nodes={nodes}
            onScopeSelect={onScopeSelect}
            onScopeDrag={onScopeDrag}
            onScopeDragEnd={onScopeDragEnd}
          />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
        {canvasContextMenu && (
          <CanvasContextMenu
            model={model}
            menu={canvasContextMenu}
            onAdd={addNodeAtContextMenu}
            onClose={() => setCanvasContextMenu(undefined)}
          />
        )}
      </main>
    </div>
  );
}

const style = document.createElement("style");
style.textContent = `
  html, body, #root {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
  }

  .shell {
    display: grid;
    grid-template-columns: auto 1fr;
    width: 100%;
    height: 100%;
  }

  .toolbox {
    box-sizing: border-box;
    width: 280px;
    padding: 14px;
    overflow: auto;
    background: var(--vscode-sideBar-background);
    border-right: 1px solid var(--vscode-panel-border);
  }

  .toolbox.collapsed {
    width: 42px;
    padding: 8px 6px;
    overflow: hidden;
  }

  .toolbox-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
  }

  .toolbox-header h2 {
    margin: 0;
  }

  .toolbox-collapse-button,
  .toolbox-toggle {
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }

  .toolbox-collapse-button {
    padding: 4px 7px;
    font-size: 11px;
  }

  .toolbox-toggle {
    width: 28px;
    min-height: 92px;
    padding: 7px 4px;
    writing-mode: vertical-rl;
    text-orientation: mixed;
  }

  .toolbox-collapse-button:hover,
  .toolbox-toggle:hover {
    color: var(--vscode-foreground);
    border-color: var(--vscode-focusBorder);
  }

  h2 {
    margin: 0 0 12px;
    font-size: 16px;
  }

  h3 {
    margin: 18px 0 8px;
    font-size: 13px;
  }

  label {
    display: block;
    margin-top: 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  input, select, textarea {
    width: 100%;
    box-sizing: border-box;
    margin-top: 5px;
    padding: 6px 7px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
  }

  textarea {
    resize: vertical;
    min-height: 54px;
  }

  .muted {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .field-editor {
    margin-top: 10px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
  }

  button {
    width: 100%;
    padding: 7px 10px;
    color: var(--vscode-foreground);
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }

  button:hover {
    border-color: var(--vscode-focusBorder);
  }

  .action-button {
    margin-top: 8px;
  }

  .action-button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }

  .function-input-list {
    display: grid;
    gap: 6px;
  }

  .function-input-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    gap: 5px;
    align-items: center;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    margin-top: 12px;
    color: var(--vscode-foreground);
    cursor: pointer;
  }

  .checkbox-label input[type="checkbox"] {
    width: auto;
    margin: 0;
  }

  .mini-action-button {
    width: auto;
    min-width: 42px;
    padding: 5px 7px;
    font-size: 11px;
    text-align: center;
  }

  .mini-action-button.danger {
    margin-top: 0;
  }

  .mini-action-button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  details {
    margin-top: 12px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
  }

  .tool-button {
    margin-top: 8px;
    cursor: grab;
  }

  .tool-button:active {
    cursor: grabbing;
  }

  .tool-button.child {
    width: calc(100% - 18px);
    margin-left: 18px;
  }

  button.danger {
    margin-top: 16px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-foreground);
  }

  button.compact {
    padding: 5px 7px;
  }

  .flow-wrap {
    position: relative;
    min-width: 0;
    height: 100%;
    --moduleflow-cardBorder: color-mix(in srgb, var(--vscode-panel-border) 72%, var(--vscode-foreground) 28%);
    --moduleflow-cardBackground: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--vscode-editor-background) 8%);
    --moduleflow-cardFooter: color-mix(in srgb, var(--vscode-sideBar-background) 72%, var(--vscode-editor-background) 28%);
    --moduleflow-dataEdge: #4aa3ff;
    --moduleflow-flowEdge: #d7a846;
    --moduleflow-inputAccent: #58c77a;
    --moduleflow-inputFill: rgba(88, 199, 122, 0.08);
    --moduleflow-markdownAccent: #4aa3ff;
    --moduleflow-markdownFill: rgba(74, 163, 255, 0.09);
    --moduleflow-scopeFill: rgba(215, 168, 70, 0.055);
    --moduleflow-scopeBorder: rgba(215, 168, 70, 0.42);
    --moduleflow-footerPortInset: 16px;
  }

  .scope-overlay-layer {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
  }

  .scope-interaction-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: visible;
    z-index: 6;
    pointer-events: auto;
  }

  .scope-overlay {
    position: absolute;
    box-sizing: border-box;
    border: 1px solid var(--moduleflow-scopeBorder);
    border-radius: 12px;
    background: var(--moduleflow-scopeFill);
    box-shadow: inset 0 0 0 1px rgba(215, 168, 70, 0.08);
    pointer-events: none;
  }

  .scope-interaction-box {
    position: absolute;
    pointer-events: none;
  }

  .react-flow__nodes {
    z-index: 3;
  }

  .scope-overlay.incomplete {
    border-style: dashed;
    opacity: 0.72;
  }

  .scope-label {
    position: absolute;
    top: -16px;
    left: 14px;
    z-index: 1;
    width: auto;
    min-width: 64px;
    padding: 5px 11px;
    color: var(--moduleflow-flowEdge);
    background: var(--vscode-editor-background);
    border: 1px solid rgba(215, 168, 70, 0.30);
    border-radius: 999px;
    cursor: grab;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: 0.04em;
    pointer-events: auto;
    text-align: center;
  }

  .scope-label:active {
    cursor: grabbing;
  }

  .scope-label:hover {
    border-color: var(--moduleflow-flowEdge);
  }

  .scope-select-zone {
    position: absolute;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 0;
    cursor: pointer;
    pointer-events: auto;
  }

  .scope-select-zone.top,
  .scope-select-zone.bottom {
    left: 10px;
    right: 10px;
    height: 10px;
  }

  .scope-select-zone.top {
    top: -5px;
  }

  .scope-select-zone.bottom {
    bottom: -5px;
  }

  .scope-select-zone.left,
  .scope-select-zone.right {
    top: 10px;
    bottom: 10px;
    width: 10px;
  }

  .scope-select-zone.left {
    left: -5px;
  }

  .scope-select-zone.right {
    right: -5px;
  }

  .react-flow__controls {
    overflow: hidden;
    background: var(--moduleflow-cardBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  }

  .react-flow__controls-button {
    width: 28px;
    height: 28px;
    padding: 6px;
    color: var(--vscode-descriptionForeground);
    background: var(--moduleflow-cardBackground);
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .react-flow__controls-button:hover {
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--moduleflow-cardBackground) 78%, var(--vscode-focusBorder) 22%);
  }

  .react-flow__controls-button svg {
    max-width: 13px;
    max-height: 13px;
  }

  .react-flow__minimap {
    overflow: hidden;
    background: color-mix(in srgb, var(--moduleflow-cardBackground) 82%, var(--vscode-editor-background) 18%);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
  }

  .react-flow__minimap-mask {
    fill: rgba(215, 168, 70, 0.10);
    stroke: var(--moduleflow-flowEdge);
    stroke-width: 1.5;
  }

  .react-flow__minimap-node {
    fill: color-mix(in srgb, var(--vscode-descriptionForeground) 52%, var(--moduleflow-cardBackground) 48%);
    stroke: transparent;
  }

  .canvas-context-menu {
    position: fixed;
    z-index: 20;
    min-width: 220px;
    max-width: 320px;
    max-height: min(520px, calc(100vh - 24px));
    overflow: auto;
    padding: 6px;
    color: var(--vscode-foreground);
    background: var(--moduleflow-cardBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  }

  .canvas-context-menu button {
    display: block;
    width: 100%;
    padding: 6px 8px;
    overflow: hidden;
    color: var(--vscode-foreground);
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .canvas-context-menu button:hover {
    background: color-mix(in srgb, var(--moduleflow-cardBackground) 72%, var(--vscode-focusBorder) 28%);
  }

  .canvas-context-menu button.child {
    padding-left: 20px;
    color: var(--vscode-descriptionForeground);
  }

  .context-menu-title {
    padding: 5px 8px 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .context-menu-divider {
    height: 1px;
    margin: 6px 0;
    background: var(--vscode-panel-border);
  }

  .node-card {
    width: 268px;
    padding: 12px 14px 0;
    border: 1px solid var(--moduleflow-cardBorder);
    border-radius: 8px;
    background: var(--moduleflow-cardBackground);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.20);
    overflow: hidden;
  }

  .node-card-input {
    border-color: color-mix(in srgb, var(--moduleflow-inputAccent) 68%, var(--moduleflow-cardBorder) 32%);
    background:
      linear-gradient(180deg, var(--moduleflow-inputFill), transparent 42%),
      var(--moduleflow-cardBackground);
  }

  .node-card-markdown {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 12px;
    border-color: color-mix(in srgb, var(--moduleflow-markdownAccent) 68%, var(--moduleflow-cardBorder) 32%);
    background:
      linear-gradient(180deg, var(--moduleflow-markdownFill), transparent 58%),
      var(--moduleflow-cardBackground);
  }

  .markdown-preview {
    flex: 1;
    min-height: 0;
    overflow: auto;
    color: var(--vscode-foreground);
    cursor: text;
    font-size: 13px;
    line-height: 1.45;
  }

  .markdown-preview.empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .markdown-preview h1,
  .markdown-preview h2,
  .markdown-preview h3,
  .markdown-preview p,
  .markdown-preview ul,
  .markdown-preview pre {
    margin: 0 0 9px;
  }

  .markdown-preview h1 {
    font-size: 20px;
  }

  .markdown-preview h2 {
    font-size: 17px;
  }

  .markdown-preview h3 {
    font-size: 14px;
  }

  .markdown-preview ul {
    padding-left: 18px;
  }

  .markdown-preview pre {
    overflow: auto;
    padding: 8px;
    background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--moduleflow-cardBackground) 18%);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
  }

  .markdown-editor {
    flex: 1;
    min-height: 0;
    resize: none;
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
    font-size: 13px;
    line-height: 1.45;
  }

  .markdown-properties {
    flex: none;
    margin-top: 10px;
  }

  .markdown-resize-handle {
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 15px;
    height: 15px;
    cursor: nwse-resize;
  }

  .markdown-resize-handle::after {
    content: "";
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 8px;
    height: 8px;
    border-right: 2px solid var(--vscode-descriptionForeground);
    border-bottom: 2px solid var(--vscode-descriptionForeground);
    opacity: 0.75;
  }

  .node-card-input .node-title,
  .node-card-input .node-title-input,
  .node-card-input .section-label {
    color: var(--moduleflow-inputAccent);
  }

  .node-card-input .input-handle,
  .node-card-input .output-handle {
    background: var(--moduleflow-inputAccent);
  }

  .react-flow__node.selected .node-card {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 10px 28px rgba(0, 0, 0, 0.28);
  }

  .node-section {
    position: relative;
    margin-top: 10px;
  }

  .node-section:first-child {
    margin-top: 0;
  }

  .section-label {
    margin-bottom: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .inline-muted {
    display: inline-block;
    margin-top: 1px;
  }

  .node-title {
    margin-top: 3px;
    font-size: 20px;
    font-weight: 700;
    line-height: 1.2;
  }

  .node-title-input {
    width: 100%;
    margin-top: 3px;
    padding: 3px 0;
    color: var(--vscode-foreground);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    font-size: 20px;
    font-weight: 700;
    line-height: 1.2;
  }

  .node-title-input:hover,
  .node-title-input:focus {
    padding: 3px 7px;
    background: var(--vscode-input-background);
    border-color: var(--vscode-focusBorder);
  }

  .node-title-label {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .node-detail {
    margin-top: 5px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    line-height: 1.35;
    word-break: break-word;
  }

  .node-warning {
    margin-top: 8px;
    padding: 6px 7px;
    color: var(--vscode-inputValidation-warningForeground);
    background: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.35;
  }

  .code-editor {
    min-height: 118px;
    margin-top: 12px;
    color: var(--vscode-editor-foreground, var(--vscode-foreground));
    background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--moduleflow-cardBackground) 18%);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
    cursor: text;
    overflow: hidden;
  }

  .code-editor:focus-within {
    border-color: var(--vscode-focusBorder);
  }

  .code-editor .cm-editor {
    min-height: 118px;
    color: var(--vscode-editor-foreground, var(--vscode-foreground));
    background: transparent;
    caret-color: var(--vscode-editorCursor-foreground, #aeafad);
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
    font-size: 12px;
    line-height: 1.45;
    cursor: text;
  }

  .code-editor .cm-scroller {
    cursor: text;
    font-family: inherit;
  }

  .code-editor .cm-content {
    min-height: 118px;
    padding: 9px 10px;
    caret-color: var(--vscode-editorCursor-foreground, #aeafad);
    cursor: text;
  }

  .code-editor .cm-cursor,
  .code-editor .cm-dropCursor {
    border-left-color: var(--vscode-editorCursor-foreground, #aeafad);
    border-left-width: 2px;
  }

  .code-editor .cm-cursor {
    animation: moduleflow-caret-blink 1.06s steps(1) infinite;
  }

  @keyframes moduleflow-caret-blink {
    0%, 49% {
      opacity: 1;
    }
    50%, 100% {
      opacity: 0;
    }
  }

  .code-editor .cm-selectionBackground,
  .code-editor .cm-content ::selection {
    background: var(--vscode-editor-selectionBackground, rgba(38, 79, 120, 0.72));
  }

  .code-editor .cm-line {
    cursor: text;
    padding: 0;
  }

  .code-editor .cm-focused {
    outline: none;
  }

  .inline-control {
    display: block;
    margin-top: 10px;
  }

  .input-row {
    position: relative;
    min-height: 18px;
    margin: 7px 0 0;
    padding-left: 8px;
    color: var(--vscode-foreground);
    font-size: 13px;
  }

  .node-properties {
    margin-top: 12px;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
  }

  .node-properties > summary {
    padding: 5px 7px;
    cursor: pointer;
    font-size: 12px;
  }

  .node-properties[open] {
    padding: 0 8px 8px;
  }

  .node-properties[open] > summary {
    margin: 0 -8px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .io-section,
  .flow-section {
    min-height: 24px;
    margin-right: -14px;
    margin-left: -14px;
    padding: 8px 24px 7px;
    color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .io-section {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 18px;
    padding: 10px 28px 10px;
    color: var(--vscode-foreground);
    text-transform: none;
    letter-spacing: 0;
  }

  .io-inputs {
    min-width: 0;
  }

  .io-outputs {
    min-width: 0;
  }

  .output-row {
    position: relative;
    min-height: 18px;
    padding-right: 8px;
    align-self: end;
    color: var(--vscode-foreground);
    font-size: 13px;
    font-weight: 700;
    line-height: 18px;
    text-align: right;
    text-transform: none;
    letter-spacing: 0;
  }

  .output-row + .output-row {
    margin-top: 7px;
  }

  .flow-section {
    margin-top: 0;
    background: var(--moduleflow-cardFooter);
    text-align: center;
  }

  .input-handle, .output-handle {
    width: 11px;
    height: 11px;
    background: var(--moduleflow-dataEdge);
    border: 1px solid var(--vscode-editor-background);
  }

  .control-handle {
    width: 11px;
    height: 11px;
    background: var(--moduleflow-flowEdge);
    border: 1px solid var(--vscode-editor-background);
  }

  .input-handle {
    left: -11px;
  }

  .output-handle {
    right: -11px;
  }

  .control-in-handle {
    left: var(--moduleflow-footerPortInset);
  }

  .control-out-handle {
    right: var(--moduleflow-footerPortInset);
  }

  .hidden-handle {
    opacity: 0;
  }
`;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>
);
