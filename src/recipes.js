// Core logic: turn "what's in my fridge" into three recipe suggestions.
//
// Flow:
//   1. normalizeInput()  - clean up and validate what the user typed
//   2. buildPrompt()     - write the instructions we send to Claude
//   3. callClaude()      - send the request, retrying on temporary failures
//   4. parseRecipes()    - turn Claude's reply (JSON text) into objects
//   5. markMissing()     - check every recipe ingredient against the fridge
//
// getRecipes() runs all five steps in order.

export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2026-10-21";
export const DEFAULT_MODEL = "claude-haiku-5-5";

// HTTP status codes that usually mean "try again in a moment"
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class RecipeError extends Error {
  // isInputError: the user typed something wrong (vs. a problem talking to Claude)
  constructor(message, { status, retryable = false, isInputError = false } = {}) {
    super(message);
    this.name = "RecipeError";
    this.status = status;
    this.retryable = retryable;
    this.isInputError = isInputError;
  }
}

// ---------------------------------------------------------------------------
// 1. Input
// ---------------------------------------------------------------------------

function toPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RecipeError(`${fieldName} must be a whole number greater than 0 (got "${value}").`, {
      isInputError: true,
    });
  }
  return number;
}

function toOptionalText(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

export function normalizeInput(raw = {}) {
  let ingredients = raw.ingredients ?? [];

  // Accept either "eggs, milk, cheese" or ["eggs", "milk", "cheese"]
  if (typeof ingredients === "string") {
    ingredients = ingredients.split(/[,\n]/);
  }
  if (!Array.isArray(ingredients)) {
    throw new RecipeError("Ingredients must be a list or a comma-separated string.", { isInputError: true });
  }

  ingredients = ingredients
    .map((item) => String(item).trim())
    .filter((item) => item !== "");

  if (ingredients.length === 0) {
    throw new RecipeError("Please give at least one ingredient.", { isInputError: true });
  }

  return {
    ingredients,
    diet: toOptionalText(raw.diet),
    cuisine: toOptionalText(raw.cuisine),
    maxTime: toPositiveInteger(raw.maxTime, "Max cook time"),
    servings: toPositiveInteger(raw.servings, "Servings"),
  };
}

// ---------------------------------------------------------------------------
// 2. Prompt
// ---------------------------------------------------------------------------

export function buildPrompt(input) {
  const constraints = [];
  if (input.diet) constraints.push(`- Dietary restriction: ${input.diet}`);
  if (input.cuisine) constraints.push(`- Cuisine: ${input.cuisine}`);
  if (input.maxTime) constraints.push(`- Maximum total cook time: ${input.maxTime} minutes`);
  if (input.servings) constraints.push(`- Servings: ${input.servings}`);

  return `You are a helpful home cook. Suggest exactly 3 different recipes.

Ingredients the user has in their fridge:
${input.ingredients.map((item) => `- ${item}`).join("\n")}

Constraints:
${constraints.length > 0 ? constraints.join("\n") : "- None"}

Rules:
- Use as many of the user's ingredients as possible and keep extra ingredients to a minimum.
- Every recipe must respect all constraints above.
- List every ingredient the recipe needs, including ones the user does not have.
- When an ingredient is one of the user's items, use the user's exact wording for "name".
- "cookTimeMinutes" is the total estimated time as a whole number.

Reply with ONLY valid JSON, no other text, in exactly this shape:
{
  "recipes": [
    {
      "title": "string",
      "cookTimeMinutes": 20,
      "ingredients": [
        { "name": "string", "quantity": "string" }
      ],
      "steps": ["string"]
    }
  ]
}`;
}

// ---------------------------------------------------------------------------
// 3. API call with retry
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt, retryAfterHeader) {
  // If the API tells us how long to wait, respect it
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  // Otherwise: 1s, 2s, 4s ... plus a little randomness
  return Math.min(1000 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250);
}

async function sendOnce(prompt, { apiKey, model, fetchFn, timeoutMs, apiUrl }) {
  let response;
  try {
    response = await fetchFn(apiUrl, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Network problems and timeouts are worth retrying
    const reason = error?.name === "TimeoutError" ? "Request timed out" : "Network error";
    throw new RecipeError(`${reason}: ${error?.message ?? error}`, { retryable: true });
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.message ?? "";
    } catch {
      // Body was not JSON; ignore
    }

    const hints = {
      401: " Check that ANTHROPIC_API_KEY in your .env file is correct.",
      404: " Check that ANTHROPIC_MODEL is a valid model name.",
    };

    const error = new RecipeError(
      `Claude API error ${response.status}${detail ? `: ${detail}` : ""}.${hints[response.status] ?? ""}`,
      { status: response.status, retryable: RETRYABLE_STATUS.has(response.status) }
    );
    error.retryAfter = response.headers?.get?.("retry-after");
    throw error;
  }

  const data = await response.json();

  if (data.stop_reason === "max_tokens") {
    throw new RecipeError("Claude's reply was cut off before it finished.", { retryable: true });
  }

  // The reply is a list of "content blocks"; we only want the text ones
  const text = (data.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (text.trim() === "") {
    throw new RecipeError("Claude returned an empty reply.", { retryable: true });
  }
  return text;
}

export async function callClaude(prompt, options = {}) {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    apiUrl = API_URL,
    fetchFn = fetch,
    maxRetries = 2,
    timeoutMs = 60_000,
    sleep = wait,
    onRetry = () => {},
  } = options;

  if (!apiKey) {
    throw new RecipeError(
      "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and put your key in it."
    );
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await sendOnce(prompt, { apiKey, model, fetchFn, timeoutMs, apiUrl });
    } catch (error) {
      const canRetry = error instanceof RecipeError && error.retryable && attempt < maxRetries;
      if (!canRetry) throw error;

      const delay = retryDelayMs(attempt, error.retryAfter);
      onRetry({ attempt: attempt + 1, delay, error });
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Parse the reply
// ---------------------------------------------------------------------------

export function parseRecipes(text) {
  // Claude sometimes wraps JSON in ```json ... ```; grab just the {...} part
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new RecipeError("Claude's reply did not contain JSON.");
  }

  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new RecipeError("Claude's reply was not valid JSON.");
  }

  if (!Array.isArray(data?.recipes) || data.recipes.length < 3) {
    throw new RecipeError("Claude did not return 3 recipes.");
  }

  return data.recipes.slice(0, 3).map((recipe, index) => {
    const label = `Recipe ${index + 1}`;

    if (typeof recipe?.title !== "string" || recipe.title.trim() === "") {
      throw new RecipeError(`${label} is missing a title.`);
    }
    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      throw new RecipeError(`${label} has no ingredients.`);
    }
    if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
      throw new RecipeError(`${label} has no steps.`);
    }

    const cookTime = Number(recipe.cookTimeMinutes);

    return {
      title: recipe.title.trim(),
      cookTimeMinutes: Number.isFinite(cookTime) && cookTime > 0 ? Math.round(cookTime) : null,
      ingredients: recipe.ingredients.map((item) => ({
        name: String(item?.name ?? item).trim(),
        quantity: String(item?.quantity ?? "").trim(),
      })),
      steps: recipe.steps.map((step) => String(step).trim()),
    };
  });
}

// ---------------------------------------------------------------------------
// 5. Mark which ingredients are missing from the fridge
// ---------------------------------------------------------------------------

// "Tomatoes" -> "tomato", "Eggs" -> "egg", "Berries" -> "berry"
function singular(word) {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

// True if every word of `short` appears, in order, inside `long`
function containsWords(long, short) {
  return short !== "" && ` ${long} `.includes(` ${short} `);
}

export function isInFridge(ingredientName, fridgeItems) {
  const ingredient = normalizeName(ingredientName);
  return fridgeItems.some((item) => {
    const fridgeItem = normalizeName(item);
    return (
      ingredient === fridgeItem ||
      containsWords(ingredient, fridgeItem) || // "boneless chicken breast" vs "chicken breast"
      containsWords(fridgeItem, ingredient) // "cherry tomatoes" vs "tomato"
    );
  });
}

export function markMissing(recipes, fridgeItems) {
  return recipes.map((recipe) => {
    const ingredients = recipe.ingredients.map((item) => ({
      ...item,
      inFridge: isInFridge(item.name, fridgeItems),
    }));
    return {
      ...recipe,
      ingredients,
      missing: ingredients.filter((item) => !item.inFridge).map((item) => item.name),
    };
  });
}

// ---------------------------------------------------------------------------
// Put it all together
// ---------------------------------------------------------------------------

export async function getRecipes(rawInput, options = {}) {
  const input = normalizeInput(rawInput);
  const prompt = buildPrompt(input);

  // If Claude replies with broken JSON, ask one more time before giving up
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await callClaude(prompt, options);
    try {
      const recipes = parseRecipes(text);
      return { input, recipes: markMissing(recipes, input.ingredients) };
    } catch (error) {
      lastError = error;
      if (attempt < 2) options.onRetry?.({ attempt, delay: 0, error });
    }
  }
  throw lastError;
}
