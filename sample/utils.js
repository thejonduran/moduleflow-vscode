

// @moduleflow:start

export async function main(input) {
  // @moduleflow:node input x:180 y:164
  // @moduleflow:node code-1783214465224 x:694 y:105 kind:code
  //comment
  // @moduleflow:node:end code-1783214465224
  // @moduleflow:node return x:1283 y:164
  return input;
}

export async function main2(input) {
  // @moduleflow:node main2-input x:165 y:546
  // @moduleflow:node main2-return x:868 y:537
  return input;
}

// @moduleflow:end
