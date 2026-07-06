const assert = require("node:assert/strict");
const { buildRegion, hasRegion, upsertRegion } = require("../out/codegen/generateRegion");
const { inspectModuleFlowRegion } = require("../out/codegen/moduleFlowRegion");
const { createModelFromSource } = require("../out/graph/jsToGraph");
const { parseExports, parseLocalFunctions, parseModuleFlowFunctions } = require("../out/analyzer/parseExports");
const { codeDependencies } = require("../out/graph/codeDependencies");
const { codeOutputs } = require("../out/graph/codeOutputs");
const { previousScopedSourceRefs, previousScopedSources } = require("../out/graph/flowDiscovery");

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
    id: "code-1",
    kind: "code",
    label: "code",
    code: "const auditedUser = user;\nconsole.log(\"user\", auditedUser);\nawait audit(auditedUser);",
    position: { x: 640, y: 260 },
    description: "Side effect block"
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
assert.match(source, /@moduleflow:node code-1 x:640 y:260 kind:code/);
assert.match(source, /@moduleflow:node:end code-1/);
assert.doesNotMatch(source, /@moduleflow:code code-1/);
const model = createModelFromSource("main.js", source, imports);

assert.equal(model.nodes.length, 6);

const [input, client, method, call, codeNode, returnNode] = model.nodes;
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

assert.equal(codeNode.kind, "code");
assert.equal(codeNode.code, "const auditedUser = user;\nconsole.log(\"user\", auditedUser);\nawait audit(auditedUser);");
assert.deepEqual(codeNode.position, { x: 640, y: 260 });
assert.equal(codeNode.description, "Side effect block");
assert.deepEqual(codeOutputs("const alpha = 1;\nlet beta = alpha;\nvar gamma;"), ["alpha", "beta", "gamma"]);
assert.deepEqual(
  codeOutputs(`
const { user, token: authToken, profile: { name = "Unknown" }, ...rest } = response;
const [first, , third = "fallback", ...remaining] = items;
`),
  ["user", "authToken", "name", "rest", "first", "third", "remaining"]
);
assert.deepEqual(codeDependencies("const message = response.message;\nconsole.log(message);"), ["response"]);
assert.deepEqual(
  codeDependencies(`
const { user, token: authToken } = response;
const message = formatMessage(user, authToken);
await audit(message, input.traceId);
`),
  ["response", "formatMessage", "audit", "input"]
);
assert.deepEqual(
  codeDependencies(`
const dude = [
  { bro: "hello" },
  { bro: "wtf" }
];
const filteredDude = dude.filter(obj => obj.bro === "hello");
console.log(filteredDude);
`),
  []
);
assert.deepEqual(
  codeDependencies("const names = people.map(({ name }) => name.toUpperCase());"),
  ["people"]
);

assert.equal(returnNode.kind, "return");
assert.equal(returnNode.source, "user");
assert.deepEqual(returnNode.position, { x: 760, y: 140 });
assert.equal(returnNode.description, "Export composed user");
assert.deepEqual(model.controlFlow, [
  { from: "input", to: "client-1" },
  { from: "client-1", to: "method-1" },
  { from: "method-1", to: "call-1" },
  { from: "call-1", to: "code-1" },
  { from: "code-1", to: "return" }
]);
assert.deepEqual(previousScopedSources(model.nodes, model.controlFlow, "return"), ["client", "result", "user", "auditedUser"]);

const safeOutsideSource = [
  'import axios from "axios";',
  "",
  "function helperOutside() {",
  "  return axios;",
  "}",
  "",
  "// @moduleflow:start",
  "export async function main(input) {",
  "  return input;",
  "}",
  "// @moduleflow:end",
  "",
  "export const after = 1;"
].join("\n");
const replacedSafeOutsideSource = upsertRegion(safeOutsideSource, buildRegion("main", nodes, [
  { from: "input", to: "return" }
]));
assert.match(replacedSafeOutsideSource, /import axios from "axios";/);
assert.match(replacedSafeOutsideSource, /function helperOutside/);
assert.match(replacedSafeOutsideSource, /export const after = 1;/);
assert.equal(hasRegion('const marker = "// @moduleflow:start";'), false);
assert.deepEqual(inspectModuleFlowRegion('const marker = "// @moduleflow:start";'), { ok: true, hasRegion: false });
assert.throws(
  () => upsertRegion("// @moduleflow:start\nexport const value = 1;\n", buildRegion("main", nodes)),
  /invalid ModuleFlow region/
);
assert.throws(
  () => upsertRegion("// @moduleflow:start\n// @moduleflow:start\n// @moduleflow:end\n", buildRegion("main", nodes)),
  /invalid ModuleFlow region/
);
const malformedMetadataSource = [
  "// @moduleflow:start",
  "export async function main(input) {",
  "  // @moduleflow:nodee input x:1 y:2 kind:input",
  "  return input;",
  "}",
  "// @moduleflow:end"
].join("\n");
assert.throws(
  () => upsertRegion(malformedMetadataSource, buildRegion("main", nodes)),
  /Unknown ModuleFlow metadata lines/
);
const repairedMetadataSource = malformedMetadataSource.replace("@moduleflow:nodee", "@moduleflow:node");
const rewrittenRepairedMetadataSource = upsertRegion(repairedMetadataSource, buildRegion("main", nodes, [
  { from: "input", to: "return" }
]));
assert.equal((rewrittenRepairedMetadataSource.match(/@moduleflow:start/g) ?? []).length, 1);
assert.equal((rewrittenRepairedMetadataSource.match(/@moduleflow:end/g) ?? []).length, 1);
const leadingBlankRegionSource = [
  "",
  "",
  "// @moduleflow:start",
  "export async function main(input) {",
  "  // @moduleflow:node input x:1 y:2 kind:input",
  "  // @moduleflow:node return x:100 y:2 kind:return",
  "  return input;",
  "}",
  "// @moduleflow:end",
  ""
].join("\n");
const rewrittenLeadingBlankRegionSource = upsertRegion(leadingBlankRegionSource, buildRegion("main", nodes, [
  { from: "input", to: "return" }
]));
assert.equal((rewrittenLeadingBlankRegionSource.match(/@moduleflow:start/g) ?? []).length, 1);
assert.equal((rewrittenLeadingBlankRegionSource.match(/@moduleflow:end/g) ?? []).length, 1);

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
  { from: "call-1", to: "code-1" },
  { from: "code-1", to: "return" },
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
const withoutLookupNodes = multiFunctionModel.nodes.filter((node) => !["lookup-input", "lookup-call", "lookup-return"].includes(node.id));
const withoutLookupControlFlow = multiFunctionModel.controlFlow.filter(
  (edge) => !edge.from.startsWith("lookup") && !edge.to.startsWith("lookup")
);
const withoutLookupSource = buildRegion("main", withoutLookupNodes, withoutLookupControlFlow);
assert.match(withoutLookupSource, /export async function main\(input\)/);
assert.doesNotMatch(withoutLookupSource, /export async function lookupUser\(input\)/);
const moduleFlowTools = parseModuleFlowFunctions(multiFunctionSource);
assert.deepEqual(moduleFlowTools.map((item) => item.name), ["main", "lookupUser"]);
assert.deepEqual(moduleFlowTools.map((item) => item.params.map((param) => param.name)), [["input"], ["input"]]);

const moduleFlowCallNodes = [
  {
    id: "input-1",
    kind: "input",
    label: "input",
    functionName: "main"
  },
  {
    id: "module-call-1",
    kind: "moduleFlowCall",
    label: "helper",
    functionNodeId: "input-2",
    inputMappings: { input: "input" },
    variableName: "helperResult"
  },
  {
    id: "return-1",
    kind: "return",
    label: "return",
    source: "helperResult"
  },
  {
    id: "input-2",
    kind: "input",
    label: "input",
    functionName: "helper"
  },
  {
    id: "return-2",
    kind: "return",
    label: "return",
    source: "input"
  }
];
const moduleFlowCallSource = buildRegion("main", moduleFlowCallNodes, [
  { from: "input-1", to: "module-call-1" },
  { from: "module-call-1", to: "return-1" },
  { from: "input-2", to: "return-2" }
]);
assert.match(moduleFlowCallSource, /const helperResult = await helper\(input\);/);
const moduleFlowCallModel = createModelFromSource("main.js", moduleFlowCallSource, []);
const moduleFlowCallNode = moduleFlowCallModel.nodes.find((node) => node.id === "module-call-1");
assert.equal(moduleFlowCallNode.kind, "moduleFlowCall");
assert.equal(moduleFlowCallNode.functionNodeId, "input-2");
assert.deepEqual(moduleFlowCallNode.inputMappings, { input: "input" });
assert.equal(moduleFlowCallNode.variableName, "helperResult");

const uniqueInputReturnSource = `
// @moduleflow:start
export async function main(input) {
  // @moduleflow:node input-100 x:1 y:2 kind:input
  // @moduleflow:node return-100 x:100 y:2 kind:return
  return input;
}

export async function main2(input) {
  // @moduleflow:node input-200 x:1 y:80 kind:input
  // @moduleflow:node return-200 x:100 y:80 kind:return
  return input;
}
// @moduleflow:end
`;
const uniqueInputReturnModel = createModelFromSource("main.js", uniqueInputReturnSource, []);
assert.deepEqual(uniqueInputReturnModel.nodes.map((node) => node.id), ["input-100", "return-100", "input-200", "return-200"]);
assert.deepEqual(uniqueInputReturnModel.controlFlow, [
  { from: "input-100", to: "return-100" },
  { from: "input-200", to: "return-200" }
]);

const duplicateCodeSourceNodes = [
  {
    id: "input1",
    kind: "input",
    label: "input",
    functionName: "first"
  },
  {
    id: "code1",
    kind: "code",
    label: "code",
    code: "const message = input.message;"
  },
  {
    id: "return1",
    kind: "return",
    label: "return",
    source: "message"
  },
  {
    id: "input2",
    kind: "input",
    label: "input",
    functionName: "second"
  },
  {
    id: "code2",
    kind: "code",
    label: "code",
    code: "const message = input.message;"
  },
  {
    id: "call2",
    kind: "call",
    label: "getUserFromResult",
    modulePath: "./utils.js",
    exportName: "getUserFromResult",
    callName: "getUser",
    params: [{ name: "result", required: true }],
    inputMappings: { result: "message" },
    variableName: "user",
    async: false
  },
  {
    id: "return2",
    kind: "return",
    label: "return",
    source: "user"
  }
];
const duplicateCodeSourceFlow = [
  { from: "input1", to: "code1" },
  { from: "code1", to: "return1" },
  { from: "input2", to: "code2" },
  { from: "code2", to: "call2" },
  { from: "call2", to: "return2" }
];
assert.deepEqual(previousScopedSources(duplicateCodeSourceNodes, duplicateCodeSourceFlow, "call2"), ["message"]);
assert.deepEqual(previousScopedSourceRefs(duplicateCodeSourceNodes, duplicateCodeSourceFlow, "call2"), [
  { nodeId: "code2", name: "message" }
]);

const wrapperTools = parseExports(`
import axios from "axios";

export function createApiClient(baseURL, token) {
  return axios.create({ baseURL, headers: { Authorization: token } });
}

export async function getJson(client, path) {
  const response = await client.get(path);
  return response.data;
}

export const postJson = async (client, path, data) => {
  const response = await client.post(path, data);
  return response.data;
};
`);
assert.deepEqual(wrapperTools.map((item) => item.name), ["createApiClient", "getJson", "postJson"]);
assert.deepEqual(wrapperTools.map((item) => item.kind), ["function", "function", "const"]);
assert.deepEqual(wrapperTools.map((item) => item.params.map((param) => param.name)), [
  ["baseURL", "token"],
  ["client", "path"],
  ["client", "path", "data"]
]);

const localToolsWithRegion = parseLocalFunctions(`
function helperOutside(input) {
  return input;
}

// @moduleflow:start
export async function main(input) {
  return input;
}
// @moduleflow:end
`);
assert.deepEqual(localToolsWithRegion.map((item) => item.name), ["helperOutside"]);

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

const legacyCodeModel = createModelFromSource("main.js", `
// @moduleflow:start
export async function main(input) {
  // @moduleflow:node input x:1 y:2
  // @moduleflow:node code-legacy x:10 y:20
  // @moduleflow:code code-legacy "const legacyValue = input.value;"
  const legacyValue = input.value;
  // @moduleflow:node return x:100 y:20
  return legacyValue;
}
// @moduleflow:end
`, []);
assert.deepEqual(legacyCodeModel.nodes.map((node) => node.kind), ["input", "code", "return"]);
assert.equal(legacyCodeModel.nodes[1].code, "const legacyValue = input.value;");

const commentOnlyCodeModel = createModelFromSource("main.js", `
// @moduleflow:start
export async function main(input) {
  // @moduleflow:node input x:1 y:2
  // @moduleflow:node code-comment x:10 y:20 kind:code
  // Keep this note on the canvas.
  // @moduleflow:node:end code-comment
  // @moduleflow:node return x:100 y:20
  return input;
}
// @moduleflow:end
`, []);
assert.deepEqual(commentOnlyCodeModel.nodes.map((node) => node.kind), ["input", "code", "return"]);
assert.equal(commentOnlyCodeModel.nodes[1].code, "// Keep this note on the canvas.");

const idOwnedMetadataModel = createModelFromSource("main.js", `
// @moduleflow:start
export async function main(input) {
  // @moduleflow:node input x:1 y:2
  // @moduleflow:description unrelated-node "Should not attach"
  // @moduleflow:node status-node x:10 y:20
  // @moduleflow:description status-node "Should attach"
  const status = chooseStatus(input.age);
  // @moduleflow:description wrong-return "Wrong return description"
  // @moduleflow:node return x:100 y:20
  // @moduleflow:description return "Right return description"
  return status;
}
// @moduleflow:end
`, []);
assert.deepEqual(idOwnedMetadataModel.nodes.map((node) => node.id), ["input", "status-node", "return"]);
assert.equal(idOwnedMetadataModel.nodes[1].description, "Should attach");
assert.equal(idOwnedMetadataModel.nodes[2].description, "Right return description");

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
