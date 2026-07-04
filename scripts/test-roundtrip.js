const assert = require("node:assert/strict");
const { buildRegion } = require("../out/codegen/generateRegion");
const { createModelFromSource } = require("../out/graph/jsToGraph");

const imports = [
  {
    fileName: "utils.js",
    modulePath: "./utils.js",
    exports: [
      {
        kind: "function",
        name: "getUserFromResult",
        callName: "getUser",
        async: false,
        params: [{ name: "result", required: true }],
        methods: []
      },
      {
        kind: "function",
        name: "calculateDistance",
        async: true,
        params: [
          { name: "origin", required: true },
          { name: "destination", required: true }
        ],
        methods: []
      }
    ]
  },
  {
    fileName: "apiClient.js",
    modulePath: "./apiClient.js",
    exports: [
      {
        kind: "class",
        name: "ApiClient",
        async: false,
        params: [{ name: "baseUrl", required: true }],
        methods: [
          {
            name: "get",
            async: true,
            params: [{ name: "path", required: true }]
          }
        ]
      }
    ]
  }
];

const nodes = [
  {
    id: "input",
    kind: "input",
    label: "input",
    functionName: "main",
    position: { x: 12, y: 34 },
    description: "Raw workflow input"
  },
  {
    id: "client-1",
    kind: "classInstance",
    label: "new ApiClient",
    modulePath: "./apiClient.js",
    exportName: "ApiClient",
    callName: "ApiClient",
    params: [{ name: "baseUrl", required: true }],
    inputMappings: { baseUrl: "input.baseUrl" },
    variableName: "client",
    position: { x: 120, y: 80 },
    description: "API client"
  },
  {
    id: "method-1",
    kind: "methodCall",
    label: "client.get",
    instanceVariableName: "client",
    methodName: "get",
    params: [{ name: "path", required: true }],
    inputMappings: { path: "input.path" },
    variableName: "result",
    async: true,
    position: { x: 300, y: 120 },
    description: "Fetch user result"
  },
  {
    id: "call-1",
    kind: "call",
    label: "getUserFromResult",
    modulePath: "./utils.js",
    exportName: "getUserFromResult",
    callName: "getUser",
    params: [{ name: "result", required: true }],
    inputMappings: { result: "result" },
    variableName: "user",
    async: false,
    position: { x: 520, y: 140 },
    description: "Extract final user"
  },
  {
    id: "return",
    kind: "return",
    label: "return",
    source: "user",
    position: { x: 760, y: 140 },
    description: "Export composed user"
  }
];

const source = buildRegion("main", nodes);
const model = createModelFromSource("main.js", source, imports);

assert.equal(model.nodes.length, 5);

const [input, client, method, call, returnNode] = model.nodes;
assert.deepEqual(input.position, { x: 12, y: 34 });
assert.equal(input.description, "Raw workflow input");

assert.equal(client.kind, "classInstance");
assert.equal(client.exportName, "ApiClient");
assert.deepEqual(client.inputMappings, { baseUrl: "input.baseUrl" });
assert.deepEqual(client.position, { x: 120, y: 80 });
assert.equal(client.description, "API client");

assert.equal(method.kind, "methodCall");
assert.equal(method.instanceVariableName, "client");
assert.equal(method.methodName, "get");
assert.deepEqual(method.inputMappings, { path: "input.path" });
assert.deepEqual(method.position, { x: 300, y: 120 });
assert.equal(method.description, "Fetch user result");

assert.equal(call.kind, "call");
assert.equal(call.exportName, "getUserFromResult");
assert.equal(call.callName, "getUser");
assert.deepEqual(call.inputMappings, { result: "result" });
assert.deepEqual(call.position, { x: 520, y: 140 });
assert.equal(call.description, "Extract final user");

assert.equal(returnNode.kind, "return");
assert.equal(returnNode.source, "user");
assert.deepEqual(returnNode.position, { x: 760, y: 140 });
assert.equal(returnNode.description, "Export composed user");
assert.deepEqual(model.controlFlow, [
  { from: "input", to: "client-1" },
  { from: "client-1", to: "method-1" },
  { from: "method-1", to: "call-1" },
  { from: "call-1", to: "return" }
]);

const reorderedSource = buildRegion("main", nodes, [
  { from: "input", to: "call-1" },
  { from: "call-1", to: "client-1" },
  { from: "client-1", to: "return" }
]);
assert.match(reorderedSource, /const user = getUser\(result\);\s+\/\/ @moduleflow:node client-1/s);
assert.doesNotMatch(reorderedSource, /await client\.get/);

const incompleteControlSource = buildRegion("main", nodes, [
  { from: "input", to: "client-1" }
]);
assert.doesNotMatch(incompleteControlSource, /const client = new ApiClient\(input\.baseUrl\);/);
assert.doesNotMatch(incompleteControlSource, /export async function main/);
assert.doesNotMatch(incompleteControlSource, /return user;/);

const multiFunctionNodes = [
  ...nodes,
  {
    id: "lookup-input",
    kind: "input",
    label: "input",
    functionName: "lookupUser",
    position: { x: 20, y: 420 }
  },
  {
    id: "lookup-call",
    kind: "call",
    label: "getUserFromResult",
    modulePath: "./utils.js",
    exportName: "getUserFromResult",
    callName: "getUser",
    params: [{ name: "result", required: true }],
    inputMappings: { result: "input.result" },
    variableName: "lookup",
    async: false,
    position: { x: 260, y: 420 }
  },
  {
    id: "lookup-return",
    kind: "return",
    label: "return",
    source: "lookup",
    position: { x: 500, y: 420 }
  },
  {
    id: "draft-node",
    kind: "call",
    label: "calculateDistance",
    modulePath: "./utils.js",
    exportName: "calculateDistance",
    params: [
      { name: "origin", required: true },
      { name: "destination", required: true }
    ],
    inputMappings: {
      origin: "input.origin",
      destination: "input.destination"
    },
    variableName: "draftDistance",
    async: true,
    position: { x: 260, y: 640 }
  }
];
const multiFunctionSource = buildRegion("main", multiFunctionNodes, [
  { from: "input", to: "client-1" },
  { from: "client-1", to: "method-1" },
  { from: "method-1", to: "call-1" },
  { from: "call-1", to: "return" },
  { from: "lookup-input", to: "lookup-call" },
  { from: "lookup-call", to: "lookup-return" }
]);
assert.match(multiFunctionSource, /export async function main\(input\)/);
assert.match(multiFunctionSource, /export async function lookupUser\(input\)/);
assert.doesNotMatch(multiFunctionSource, /draftDistance/);
const multiFunctionModel = createModelFromSource("main.js", multiFunctionSource, imports);
assert.deepEqual(
  multiFunctionModel.controlFlow.filter((edge) => edge.from.startsWith("lookup") || edge.to.startsWith("lookup")),
  [
    { from: "lookup-input", to: "lookup-call" },
    { from: "lookup-call", to: "lookup-return" }
  ]
);

const formattedSource = `
// @moduleflow:start
export async function main(input) {
  // @moduleflow:node input x:1 y:2
  // @moduleflow:description input "Formatted input"
  // @moduleflow:node client-node x:10 y:20
  const client = new ApiClient(input.baseUrl);

  // @moduleflow:node result-node x:50 y:60
  const result = await client.get(input.path);

  // @moduleflow:node distance-node x:70 y:80
  const distance = await calculateDistance(
    input.origin,
    input.destination
  );

  // @moduleflow:node return x:110 y:120
  return distance;
}
// @moduleflow:end
`;

const formattedModel = createModelFromSource("main.js", formattedSource, imports);
assert.equal(formattedModel.nodes.length, 5);

const formattedInput = formattedModel.nodes[0];
assert.deepEqual(formattedInput.position, { x: 1, y: 2 });
assert.equal(formattedInput.description, "Formatted input");

const classNode = formattedModel.nodes[1];
assert.equal(classNode.kind, "classInstance");
assert.equal(classNode.exportName, "ApiClient");
assert.deepEqual(classNode.inputMappings, { baseUrl: "input.baseUrl" });

const methodNode = formattedModel.nodes[2];
assert.equal(methodNode.kind, "methodCall");
assert.equal(methodNode.instanceVariableName, "client");
assert.equal(methodNode.methodName, "get");
assert.equal(methodNode.async, true);
assert.deepEqual(methodNode.inputMappings, { path: "input.path" });

const asyncCallNode = formattedModel.nodes[3];
assert.equal(asyncCallNode.kind, "call");
assert.equal(asyncCallNode.exportName, "calculateDistance");
assert.equal(asyncCallNode.async, true);
assert.deepEqual(asyncCallNode.inputMappings, {
  origin: "input.origin",
  destination: "input.destination"
});

const formattedReturn = formattedModel.nodes[4];
assert.equal(formattedReturn.kind, "return");
assert.equal(formattedReturn.source, "distance");
assert.deepEqual(formattedReturn.position, { x: 110, y: 120 });
assert.deepEqual(formattedModel.controlFlow, [
  { from: "input", to: "client-node" },
  { from: "client-node", to: "result-node" },
  { from: "result-node", to: "distance-node" },
  { from: "distance-node", to: "return" }
]);

const changedSignatureImports = [
  {
    fileName: "utils.js",
    modulePath: "./utils.js",
    exports: [
      {
        kind: "function",
        name: "calculateDistance",
        async: true,
        params: [
          { name: "origin", required: true },
          { name: "destination", required: true },
          { name: "options", required: false, defaultValue: "{}" }
        ],
        methods: []
      }
    ]
  }
];

const changedSignatureSource = `
// @moduleflow:start
export async function main(input) {
  const distance = await calculateDistance(input.origin, input.destination);
  return distance;
}
// @moduleflow:end
`;

const changedSignatureModel = createModelFromSource("main.js", changedSignatureSource, changedSignatureImports);
const changedSignatureNode = changedSignatureModel.nodes[1];
assert.equal(changedSignatureNode.kind, "call");
assert.deepEqual(changedSignatureNode.params.map((param) => param.name), ["origin", "destination", "options"]);
assert.deepEqual(changedSignatureNode.inputMappings, {
  origin: "input.origin",
  destination: "input.destination",
  options: "input.options"
});

const missingToolModel = createModelFromSource("main.js", changedSignatureSource, []);
const missingToolNode = missingToolModel.nodes[1];
assert.equal(missingToolNode.kind, "call");
assert.equal(missingToolNode.exportName, "calculateDistance");
assert.equal(missingToolNode.modulePath, "moduleflow:missing");
assert.deepEqual(missingToolNode.params.map((param) => param.name), ["arg1", "arg2"]);
assert.deepEqual(missingToolNode.inputMappings, {
  arg1: "input.origin",
  arg2: "input.destination"
});
assert.match(missingToolNode.warning, /not found/);

const missingMethodSource = `
// @moduleflow:start
export async function main(input) {
  const client = new ApiClient(input.baseUrl);
  const result = await client.get("/users");
  return result;
}
// @moduleflow:end
`;

const missingMethodImports = [
  {
    fileName: "apiClient.js",
    modulePath: "./apiClient.js",
    exports: [
      {
        kind: "class",
        name: "ApiClient",
        async: false,
        params: [{ name: "baseUrl", required: true }],
        methods: []
      }
    ]
  }
];

const missingMethodModel = createModelFromSource("main.js", missingMethodSource, missingMethodImports);
const missingMethodNode = missingMethodModel.nodes[2];
assert.equal(missingMethodNode.kind, "methodCall");
assert.equal(missingMethodNode.methodName, "get");
assert.deepEqual(missingMethodNode.params.map((param) => param.name), ["arg1"]);
assert.deepEqual(missingMethodNode.inputMappings, { arg1: "\"/users\"" });
assert.match(missingMethodNode.warning, /Method "get" was not found/);

const localCallModel = createModelFromSource("main.js", `
// @moduleflow:start
export async function main(input) {
  // @moduleflow:node status-node x:10 y:20
  // @moduleflow:description status-node "Local helper outside ModuleFlow"
  const status = chooseStatus(input.age, input.hasConsent);
  return status;
}
// @moduleflow:end
`, []);
assert.equal(localCallModel.nodes.length, 3);
const localCallNode = localCallModel.nodes[1];
assert.equal(localCallNode.kind, "call");
assert.equal(localCallNode.exportName, "chooseStatus");
assert.deepEqual(localCallNode.inputMappings, { arg1: "input.age", arg2: "input.hasConsent" });
assert.deepEqual(localCallNode.position, { x: 10, y: 20 });
assert.equal(localCallNode.description, "Local helper outside ModuleFlow");
assert.match(localCallNode.warning, /Function export "chooseStatus" was not found/);

const expressionModel = createModelFromSource("main.js", `
// @moduleflow:start
export async function main(input) {
  const isAdult = input.age >= 18;
  const summary = { isAdult };
  return summary;
}
// @moduleflow:end
`, []);
assert.deepEqual(expressionModel.nodes.map((node) => node.kind), ["input", "return"]);
assert.equal(expressionModel.nodes[1].source, "summary");

const legacyGroupModel = createModelFromSource("main.js", `
// @moduleflow:start
export async function main(input) {
  // @moduleflow:node group-1 x:200 y:100 w:460 h:320 mode:scope
  // @moduleflow:description group-1 "Legacy visual group"
  // @moduleflow:node literal-inside x:40 y:60 parent:group-1
  const innerValue = "inside";
  return innerValue;
}
// @moduleflow:end
`, []);
assert.equal(legacyGroupModel.nodes.some((node) => node.kind === "group"), false);
assert.equal(legacyGroupModel.nodes.some((node) => node.id === "literal-inside"), false);
const flattenedLegacySource = buildRegion("main", legacyGroupModel.nodes);
assert.doesNotMatch(flattenedLegacySource, /parent:group-1/);
assert.doesNotMatch(flattenedLegacySource, /w:460/);
assert.doesNotMatch(flattenedLegacySource, /mode:scope/);

console.log("ModuleFlow roundtrip test passed.");
