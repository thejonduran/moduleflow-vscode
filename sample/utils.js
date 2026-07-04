import { ApiClient, main } from "./apiClient.js";

function test(baseUrl) {
  return "This is a test function.";
};

// @moduleflow:start
export async function main(input) {
  // @moduleflow:node input x:-224 y:-133
  // @moduleflow:node return x:732 y:-138
  return input;
}
// @moduleflow:end
