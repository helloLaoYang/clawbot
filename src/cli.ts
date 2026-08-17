#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

type Output = { log(message: string): void; error(message: string): void };

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  output: Output = console,
): Promise<number> {
  const command = argv[0] ?? "serve";
  const options = parseOptions(argv.slice(1));
  if (command === "help" || options.help) {
    output.log(helpText);
    return 0;
  }
  if (command === "serve") {
    const config = loadConfig(env);
    const runtime = createRuntime(config);
    runtime.monitor.start();
    const shutdown = async () => {
      runtime.monitor.stop();
      await runtime.server.close();
      runtime.store.close();
    };
    process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
    await runtime.server.listen({ host: config.host, port: config.port });
    output.log(`Clawbot listening on http://${config.host}:${config.port}`);
    return 0;
  }
  if (command === "send") {
    const peerId = options.peer;
    const text = options.text;
    const token = options.token ?? env.WEBHOOK_TOKEN ?? env.ADMIN_TOKEN;
    if (!peerId || !text || !token) {
      output.error("send requires --peer, --text and WEBHOOK_TOKEN (or --token)");
      return 2;
    }
    const baseUrl = normalizeBaseUrl(options.url ?? env.CLAWBOT_URL ?? "http://127.0.0.1:3000");
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/webhooks/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(options["idempotency-key"] ? { "idempotency-key": options["idempotency-key"] } : {}),
        },
        body: JSON.stringify({ peer_id: peerId, text }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      output.error(`send failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const body = await response.text();
    if (!response.ok) {
      output.error(`send failed (${response.status}): ${body}`);
      return 1;
    }
    output.log(body);
    return 0;
  }
  if (command === "status" || command === "peers") {
    const token = options.token ?? (command === "peers" ? env.WEBHOOK_TOKEN ?? env.ADMIN_TOKEN : env.ADMIN_TOKEN);
    if (!token) { output.error(`${command} requires a token (or --token)`); return 2; }
    const baseUrl = normalizeBaseUrl(options.url ?? env.CLAWBOT_URL ?? "http://127.0.0.1:3000");
    const path = command === "peers" ? "/api/webhooks/peers" : "/api/admin/status";
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      output.error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const body = await response.text();
    if (!response.ok) { output.error(`${command} failed (${response.status}): ${body}`); return 1; }
    output.log(body);
    return 0;
  }
  output.error(`unknown command: ${command}\n\n${helpText}`);
  return 2;
}

function parseOptions(args: string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals > 2) result[argument.slice(2, equals)] = argument.slice(equals + 1);
    else if (args[index + 1] && !args[index + 1]!.startsWith("--")) result[argument.slice(2)] = args[++index];
    else result[argument.slice(2)] = "true";
  }
  return result;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

const helpText = `Clawbot CLI

Usage:
  clawbot serve
  clawbot status [--url URL] [--token ADMIN_TOKEN]
  clawbot peers [--url URL] [--token WEBHOOK_TOKEN]
  clawbot send --peer USER_ID --text MESSAGE [--idempotency-key KEY] [--url URL] [--token WEBHOOK_TOKEN]

Environment:
  CLAWBOT_URL       Service URL for status/send (default http://127.0.0.1:3000)
  ADMIN_TOKEN       Token for status and fallback token for send
  WEBHOOK_TOKEN     Token for send

Local usage automatically loads .env, so --token is not required.`;

export function loadLocalEnvironment(loader: (path?: string) => void = loadEnvFile): void {
  try {
    loader(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadLocalEnvironment();
  process.exitCode = await runCli(process.argv.slice(2));
}
