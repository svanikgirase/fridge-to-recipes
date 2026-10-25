// Minimal web UI (bonus). Run with: node src/server.js  then open http://localhost:3000
//
// GET  /             -> the web page (public/index.html)
// POST /api/recipes  -> { ingredients, diet, cuisine, maxTime, servings } in, { recipes } out

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "./env.js";
import { getRecipes, RecipeError, DEFAULT_MODEL } from "./recipes.js";

const PAGE_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));
const MAX_BODY_BYTES = 10_000;

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new RecipeError("Request is too large.", { isInputError: true });
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new RecipeError("Request body must be valid JSON.", { isInputError: true });
  }
}

// `options` is passed through to getRecipes (apiKey, model, and fetchFn for tests)
export function createApp(options = {}) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        const page = await readFile(PAGE_PATH);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page);
      }

      if (req.method === "POST" && req.url === "/api/recipes") {
        let input;
        try {
          input = await readJsonBody(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }

        try {
          const { recipes } = await getRecipes(input, {
            ...options,
            onRetry: ({ attempt, error }) =>
              console.error(`Attempt ${attempt} failed (${error.message}), retrying...`),
          });
          return sendJson(res, 200, { recipes });
        } catch (error) {
          // Problems with what the user typed -> 400. Problems talking to Claude -> 502.
          console.error(`Error: ${error.message}`);
          return sendJson(res, error.isInputError ? 400 : 502, { error: error.message });
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: "Something went wrong on the server." });
    }
  });
}

// Only start listening when this file is run directly (not when imported by tests)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const port = Number(process.env.PORT) || 3000;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. Requests will fail until you add it to .env.");
  }

  createApp({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model,
    apiUrl: process.env.ANTHROPIC_API_URL || undefined,
  }).listen(port, () => {
    console.log(`Fridge-to-Recipes is running at http://localhost:${port}  (model: ${model})`);
  });
}
