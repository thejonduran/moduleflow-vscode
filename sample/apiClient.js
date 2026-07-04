export class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  async get(path) {
    const response = await fetch(`${this.baseUrl}${path}`);
    return response.json();
  }

  async post(path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    return response.json();
  }
}

// @moduleflow:start
export async function main(input) {
  // @moduleflow:node return x:910 y:114
  return input;
}
// @moduleflow:end
