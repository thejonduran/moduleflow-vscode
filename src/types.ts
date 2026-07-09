export type ExportKind = "function" | "class" | "const";

export type ExportParameter = {
  name: string;
  required: boolean;
  defaultValue?: string;
};

export type MethodDefinition = {
  name: string;
  async: boolean;
  params: ExportParameter[];
};

export type InputMappings = Record<string, string>;

export type NodePosition = {
  x: number;
  y: number;
};

export type NodeSize = {
  width: number;
  height: number;
};

export type NodeMetadata = {
  description?: string;
  warning?: string;
};

export type ControlFlowEdge = {
  from: string;
  to: string;
};

export type ModuleExport = {
  kind: ExportKind;
  name: string;
  callName?: string;
  async: boolean;
  params: ExportParameter[];
  methods: MethodDefinition[];
};

export type ImportedToolModule = {
  fileName: string;
  modulePath: string;
  exports: ModuleExport[];
};

export type ModuleFlowNode =
  | {
      id: string;
      kind: "input";
      label: string;
      functionName: string;
      params: ExportParameter[];
      returnSource?: string;
      execute?: boolean;
      position?: NodePosition;
      size?: NodeSize;
      description?: string;
      warning?: string;
    }
  | {
      id: string;
      kind: "code";
      label: string;
      code: string;
      position?: NodePosition;
      size?: NodeSize;
      description?: string;
      warning?: string;
    }
  | {
      id: string;
      kind: "markdown";
      label: string;
      markdown: string;
      parentNodeId?: string;
      position?: NodePosition;
      size?: NodeSize;
      description?: string;
      warning?: string;
    }
  | {
      id: string;
      kind: "call";
      label: string;
      modulePath: string;
      exportName: string;
      callName?: string;
      params: ExportParameter[];
      inputMappings: InputMappings;
      variableName: string;
      async: boolean;
      position?: NodePosition;
      size?: NodeSize;
      description?: string;
      warning?: string;
    }
  | {
      id: string;
      kind: "moduleFlowCall";
      label: string;
      functionNodeId: string;
      inputMappings: InputMappings;
      variableName: string;
      position?: NodePosition;
      size?: NodeSize;
      description?: string;
      warning?: string;
    }
  | {
      id: string;
      kind: "classInstance";
      label: string;
      modulePath: string;
      exportName: string;
      callName?: string;
      params: ExportParameter[];
      inputMappings: InputMappings;
      variableName: string;
      position?: NodePosition;
      size?: NodeSize;
      description?: string;
      warning?: string;
    }
  | {
      id: string;
      kind: "methodCall";
      label: string;
      instanceVariableName: string;
      methodName: string;
      params: ExportParameter[];
      inputMappings: InputMappings;
      variableName: string;
      async: boolean;
      position?: NodePosition;
      size?: NodeSize;
      description?: string;
      warning?: string;
    };

export type ModuleFlowModel = {
  targetFile: string;
  imports: ImportedToolModule[];
  nodes: ModuleFlowNode[];
  controlFlow: ControlFlowEdge[];
};
