

// @moduleflow:start

export async function main(input) {
  // @moduleflow:node input x:3 y:105
  // @moduleflow:node code-1783210562695 x:412 y:61
  // @moduleflow:description code-1783210562695 "This is a random description of what were doing"
  // @moduleflow:code code-1783210562695 "// write code here\nconsole.log(\"Hello There\");\nconst helloWorld = {\n  hello: \"World\",\n  how: \"Are you?\"\n}\nconst dude = \"bro\""
  // write code here
  console.log("Hello There");
  const helloWorld = {
    hello: "World",
    how: "Are you?"
  }
  const dude = "bro"
  // @moduleflow:node return x:838 y:64
  return dude;
}

// @moduleflow:end
