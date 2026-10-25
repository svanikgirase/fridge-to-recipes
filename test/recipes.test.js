import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInput,
  buildPrompt,
  parseRecipes,
  isInFridge,
  markMissing,
  callClaude,
  getRecipes,
  RecipeError,
} from "../src/recipes.js";

// --- Helpers -----------------------------------------------------------------

const SAMPLE_REPLY = {
  recipes: [1, 2, 3].map((n) => ({
    title: `Dish ${n}`,
    cookTimeMinutes: 10 * n,
    ingredients: [
      { name: "eggs", quantity: "2" },
      { name: "butter", quantity: "1 tbsp" },
    ],
    steps: ["Do the thing.", "Eat."],
  })),
};

// A fake fetch that returns the given responses in order
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Headers(next.headers ?? {}),
      json: async () => next.body,
    };
  };
  fn.calls = calls;
  return fn;
}

const okResponse = (text) => ({
  status: 200,
  body: { content: [{ type: "text", text }], stop_reason: "end_turn" },
});

const noSleep = async () => {};

// --- normalizeInput ----------------------------------------------------------

test("normalizeInput splits a comma-separated string and trims it", () => {
  const input = normalizeInput({ ingredients: " eggs, spinach ,, feta ", maxTime: "30", servings: 2 });
  assert.deepEqual(input.ingredients, ["eggs", "spinach", "feta"]);
  assert.equal(input.maxTime, 30);
  assert.equal(input.servings, 2);
  assert.equal(input.diet, undefined);
});

test("normalizeInput rejects empty ingredients", () => {
  assert.throws(() => normalizeInput({ ingredients: " , " }), { isInputError: true });
});

test("normalizeInput rejects a bad cook time", () => {
  assert.throws(() => normalizeInput({ ingredients: "eggs", maxTime: "abc" }), /whole number/);
  assert.throws(() => normalizeInput({ ingredients: "eggs", servings: -2 }), /whole number/);
});

// --- buildPrompt -------------------------------------------------------------

test("buildPrompt includes ingredients and only the given constraints", () => {
  const prompt = buildPrompt(normalizeInput({ ingredients: "eggs, rice", diet: "vegetarian", maxTime: 20 }));
  assert.match(prompt, /- eggs/);
  assert.match(prompt, /- rice/);
  assert.match(prompt, /Dietary restriction: vegetarian/);
  assert.match(prompt, /20 minutes/);
  assert.doesNotMatch(prompt, /Cuisine:/);
});

// --- parseRecipes ------------------------------------------------------------

test("parseRecipes handles JSON wrapped in a code fence", () => {
  const text = "```json\n" + JSON.stringify(SAMPLE_REPLY) + "\n```";
  const recipes = parseRecipes(text);
  assert.equal(recipes.length, 3);
  assert.equal(recipes[0].title, "Dish 1");
  assert.equal(recipes[2].cookTimeMinutes, 30);
});

test("parseRecipes rejects broken or incomplete replies", () => {
  assert.throws(() => parseRecipes("Sorry, I can't help."), RecipeError);
  assert.throws(() => parseRecipes("{ not json }"), /not valid JSON/);
  assert.throws(() => parseRecipes(JSON.stringify({ recipes: [SAMPLE_REPLY.recipes[0]] })), /3 recipes/);
});

// --- Missing ingredients -----------------------------------------------------

test("isInFridge matches plurals and longer names", () => {
  const fridge = ["Eggs", "cherry tomatoes", "chicken breast"];
  assert.equal(isInFridge("egg", fridge), true);
  assert.equal(isInFridge("tomato", fridge), true);
  assert.equal(isInFridge("boneless chicken breasts", fridge), true);
  assert.equal(isInFridge("butter", fridge), false);
});

test("markMissing flags items not in the fridge", () => {
  const [recipe] = markMissing(parseRecipes(JSON.stringify(SAMPLE_REPLY)), ["eggs"]);
  assert.deepEqual(
    recipe.ingredients.map((item) => item.inFridge),
    [true, false]
  );
  assert.deepEqual(recipe.missing, ["butter"]);
});

// --- callClaude: retries -----------------------------------------------------

test("callClaude retries on a 529 overloaded error, then succeeds", async () => {
  const fetchFn = fakeFetch([{ status: 529, body: { error: { message: "Overloaded" } } }, okResponse("hi")]);
  const retries = [];
  const text = await callClaude("prompt", {
    apiKey: "test-key",
    fetchFn,
    sleep: noSleep,
    onRetry: (info) => retries.push(info),
  });
  assert.equal(text, "hi");
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(retries.length, 1);
});

test("callClaude retries on a network error", async () => {
  const fetchFn = fakeFetch([new TypeError("fetch failed"), okResponse("ok")]);
  assert.equal(await callClaude("p", { apiKey: "k", fetchFn, sleep: noSleep }), "ok");
});

test("callClaude does not retry a 401 and explains the problem", async () => {
  const fetchFn = fakeFetch([{ status: 401, body: { error: { message: "invalid x-api-key" } } }]);
  await assert.rejects(callClaude("p", { apiKey: "bad", fetchFn, sleep: noSleep }), /ANTHROPIC_API_KEY/);
  assert.equal(fetchFn.calls.length, 1);
});

test("callClaude gives up after maxRetries", async () => {
  const fetchFn = fakeFetch([{ status: 503, body: {} }]);
  await assert.rejects(callClaude("p", { apiKey: "k", fetchFn, sleep: noSleep, maxRetries: 2 }), /503/);
  assert.equal(fetchFn.calls.length, 3); // 1 try + 2 retries
});

test("callClaude fails fast without an API key", async () => {
  await assert.rejects(callClaude("p", { apiKey: "" }), /Missing ANTHROPIC_API_KEY/);
});

test("callClaude sends the key in a header, not in the body", async () => {
  const fetchFn = fakeFetch([okResponse("ok")]);
  await callClaude("p", { apiKey: "secret-key", fetchFn, sleep: noSleep });
  const { init } = fetchFn.calls[0];
  assert.equal(init.headers["x-api-key"], "secret-key");
  assert.doesNotMatch(init.body, /secret-key/);
});

// --- getRecipes end to end ---------------------------------------------------

test("getRecipes returns 3 recipes with missing items marked", async () => {
  const fetchFn = fakeFetch([okResponse(JSON.stringify(SAMPLE_REPLY))]);
  const { recipes } = await getRecipes({ ingredients: "eggs" }, { apiKey: "k", fetchFn, sleep: noSleep });
  assert.equal(recipes.length, 3);
  assert.deepEqual(recipes[0].missing, ["butter"]);
});

test("getRecipes asks again once if the reply is not valid JSON", async () => {
  const fetchFn = fakeFetch([okResponse("oops"), okResponse(JSON.stringify(SAMPLE_REPLY))]);
  const { recipes } = await getRecipes({ ingredients: "eggs" }, { apiKey: "k", fetchFn, sleep: noSleep });
  assert.equal(recipes.length, 3);
  assert.equal(fetchFn.calls.length, 2);
});
