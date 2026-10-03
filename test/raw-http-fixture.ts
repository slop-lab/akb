import { request } from "node:http"

export type RawRequest = {
  readonly port: number
  readonly method: "GET" | "POST" | "PATCH"
  readonly path: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
}

export type RawResponse = {
  readonly status: number
  readonly body: string
}

export function sendRawRequest(input: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      },
    )
    clientRequest.on("error", reject)
    clientRequest.end(input.body)
  })
}
