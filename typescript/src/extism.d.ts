// Ambient type declarations for the Extism JS/TS PDK globals provided by extism-js.

declare namespace Host {
  function inputString(): string;
  function outputString(output: string): void;
}

declare namespace Http {
  interface RequestOptions {
    url: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
    headers?: Record<string, string>;
  }

  interface Response {
    status: number;
    body: string;
  }

  function request(req: RequestOptions, body?: string): Response;
}
