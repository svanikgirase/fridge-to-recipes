#!/usr/bin/env node
// Command-line interface.
//
// Example:
//   node src/cli.js --ingredients "eggs, spinach, feta, tomatoes" --diet vegetarian --max-time 30 --servings 2

import { parseArgs } from "node:util";
import { loadEnv } from "./env.js";
import { getRecipes, DEFAULT_MODEL } from "./recipes.js";

const HELP = `Fridge-to-Recipes: get 3 recipe ideas from what's in your fridge.

Usage:
  node src/cli.js --ingredients "eggs, spinach, feta" [options]

Options:
  -i, --ingredients  Comma-separated list of what you have (required)
  -d, --diet         Dietary restriction, e.g. vegetarian, vegan, gluten-free
  -c, --cuisine      Cuisine, e.g. italian, indian, mexican
  -t, --max-time     Maximum cook time in minutes
  -s, --servings     Number of servings
      --json         Print raw JSON instead of formatted text
  -h, --help         Show this help
`;

function formatRecipe(recipe, number) {
  const lines = [];
  const time = recipe.cookTimeMinutes ? `${recipe.cookTimeMinutes} min` : "time unknown";

  lines.push("=".repeat(60));
  lines.push(`Recipe ${number}: ${recipe.title}  (about ${time})`);
  lines.push("=".repeat(60));

  lines.push("Ingredients:");
  for (const item of recipe.ingredients) {
    const tag = item.inFridge ? "[have]   " : "[MISSING]";
    const amount = item.quantity ? `${item.quantity} ` : "";
    lines.push(`  ${tag} ${amount}${item.name}`);
  }

  lines.push(
    recipe.missing.length > 0
      ? `  -> You need to buy: ${recipe.missing.join(", ")}`
      : "  -> You have everything!"
  );

  lines.push("", "Steps:");
  recipe.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));

  return lines.join("\n");
}

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        ingredients: { type: "string", short: "i" },
        diet: { type: "string", short: "d" },
        cuisine: { type: "string", short: "c" },
        "max-time": { type: "string", short: "t" },
        servings: { type: "string", short: "s" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    console.error(HELP);
    process.exit(1);
  }

  if (args.help || !args.ingredients) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  loadEnv();

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  if (!args.json) console.error(`Asking Claude (${model}) for recipes...\n`);

  try {
    const { recipes } = await getRecipes(
      {
        ingredients: args.ingredients,
        diet: args.diet,
        cuisine: args.cuisine,
        maxTime: args["max-time"],
        servings: args.servings,
      },
      {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model,
        apiUrl: process.env.ANTHROPIC_API_URL || undefined,
        onRetry: ({ attempt, delay, error }) =>
          console.error(`  Attempt ${attempt} failed (${error.message}) - retrying in ${Math.round(delay / 1000)}s...`),
      }
    );

    if (args.json) {
      console.log(JSON.stringify(recipes, null, 2));
    } else {
      console.log(recipes.map((recipe, i) => formatRecipe(recipe, i + 1)).join("\n\n"));
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
