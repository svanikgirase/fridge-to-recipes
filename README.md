# Fridge-to-Recipes

Tell the app what ingredients you have, plus optional constraints (diet, cuisine, max cook time, servings), and it suggests **three recipes**. For each recipe you get:

- the title
- the full ingredient list, with every item marked as **have** or **MISSING** from your fridge
- step-by-step instructions
- an estimated cook time

It uses the [Anthropic Claude API](https://platform.claude.com/docs/en/api/overview) to generate the recipes. You can use it from the command line (CLI) or through a small web page.

## Requirements

- [Node.js](https://nodejs.org) 18.17 or newer (no `npm install` needed, there are no dependencies)
- An Anthropic API key from the [Anthropic Console](https://console.anthropic.com)

## Setup

1. Clone the repo and go into the folder:

   ```bash
   git clone <your-repo-url>
   cd fridge-to-recipes
   ```

2. Create your `.env` file from the example:

   ```bash
   # macOS / Linux
   cp .env.example .env

   # Windows (PowerShell)
   Copy-Item .env.example .env
   ```

3. Open `.env` and replace `your-key-here` with your real API key.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | | Your Anthropic API key |
| `ANTHROPIC_MODEL` | No | `claude-haiku-5-5` | Which Claude model to use |
| `PORT` | No | `3000` | Port for the web UI |

The key is read from `.env` (or from a real environment variable, which takes priority). `.env` is listed in `.gitignore`, so **the key is never committed**. Only `.env.example`, which contains a placeholder, is in the repo.

## Usage

### Command line

```bash
node src/cli.js --ingredients "eggs, spinach, feta, tomatoes" --diet vegetarian --cuisine greek --max-time 30 --servings 2
```

| Option | Short | Description |
|---|---|---|
| `--ingredients` | `-i` | Comma-separated list of what you have (required) |
| `--diet` | `-d` | e.g. `vegetarian`, `vegan`, `gluten-free` |
| `--cuisine` | `-c` | e.g. `italian`, `indian`, `mexican` |
| `--max-time` | `-t` | Maximum cook time in minutes |
| `--servings` | `-s` | Number of servings |
| `--json` | | Print raw JSON instead of formatted text |
| `--help` | `-h` | Show help |

All constraints are optional. You can use any combination of them.

### Web UI (bonus)

```bash
node src/server.js
```

Then open <http://localhost:3000>, type your ingredients, and click **Get recipes**.

### Tests

```bash
npm test
```

The tests use a fake API, so they run without an API key and without internet.

## Example run

Command:

```bash
node src/cli.js --ingredients "eggs, spinach, feta, tomatoes" --diet vegetarian --cuisine greek --max-time 30 --servings 2
```

Output:

```text
TODO: run the command above with your real API key and paste the output here.
```

## How it works

```
src/
  cli.js       command-line interface: reads flags, prints formatted recipes
  server.js    web server: serves the page and a POST /api/recipes endpoint
  recipes.js   core logic (used by both the CLI and the web server)
  env.js       loads variables from .env
public/
  index.html   the web page
test/
  recipes.test.js
```

`recipes.js` does the work in five steps:

1. **Validate input**: splits the ingredient list, checks that cook time and servings are positive whole numbers.
2. **Build a prompt**: lists the ingredients and only the constraints the user gave, and asks Claude to reply with JSON in a fixed shape.
3. **Call the API**: sends the request with a 60-second timeout.
4. **Parse the reply**: extracts the JSON and checks that there are 3 recipes, each with a title, ingredients and steps.
5. **Mark missing ingredients**: the app itself (not the AI) compares every recipe ingredient with your list. It handles plurals ("tomato" vs "tomatoes") and longer names ("boneless chicken breast" vs "chicken breast").

### Error handling and retries

- **Transient API failures are retried** up to 2 times (3 attempts total) with exponential backoff (about 1s, then 2s), respecting the `retry-after` header if the API sends one. Retried: network errors, timeouts, and HTTP `408`, `409`, `429`, `500`, `502`, `503`, `504`, `529`.
- **Permanent errors are not retried** (e.g. `401` wrong key, `400` bad request) and show a clear message, with a hint for a wrong key or model name.
- If Claude replies with invalid JSON, the app asks **once more** before giving up.
- Bad user input (no ingredients, `--max-time abc`) is rejected before any API call. The web endpoint returns `400` for bad input and `502` for API problems.
- A missing API key gives a clear message instead of a crash.

### Known limitations

- Ingredient matching is word-based, so it can be fooled, e.g. "milk" in your fridge will count as having "coconut milk".
- Basic pantry staples like salt or oil are marked missing unless you list them.

## How AI was used

This project was built with AI assistance (Claude) as part of the course *AI for Software Developers*. The AI helped design the structure, write the code and tests, and look up the current Claude API details.
