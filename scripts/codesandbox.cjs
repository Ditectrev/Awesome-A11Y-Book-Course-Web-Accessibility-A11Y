#!/usr/bin/env node
/**
 * Automate CodeSandbox creation from README.md code examples.
 *
 * Sandbox content policy (aligned with examples 001–033):
 *   - HTML-only in README: body fragments stay in the book; sandbox gets a full document.
 *   - CSS add-on in README: book and sandbox both show one full index.html
 *     (preceding HTML + all CSS blocks since that HTML).
 *
 * Usage:
 *   CSB_API_KEY=... node scripts/codesandbox.cjs verify
 *   CSB_API_KEY=... node scripts/codesandbox.cjs scan
 *   CSB_API_KEY=... node scripts/codesandbox.cjs create --next
 *   CSB_API_KEY=... node scripts/codesandbox.cjs insert --index 34
 */

const fs = require("fs");
const path = require("path");
const { getParameters } = require("codesandbox/lib/api/define");

const ROOT = path.resolve(__dirname, "..");
const README = path.join(ROOT, "README.md");
const MANIFEST = path.join(__dirname, "sandboxes-manifest.json");
const CONFIG_PATH = path.join(__dirname, "codesandbox.config.json");
const ENV_PATH = path.join(ROOT, ".env");

const DEFINE_URL = "https://codesandbox.io/api/v1/sandboxes/define?json=1";
const API_BASE = "https://api.codesandbox.io";

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function getApiKey() {
  return process.env.CSB_API_KEY || process.env.CODESANDBOX_API_TOKEN || null;
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return { examples: {} };
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function maxExistingNumber(content) {
  const matches = [...content.matchAll(/\[\!\[Edit (\d+)-/g)];
  if (matches.length === 0) return 0;
  return Math.max(...matches.map((m) => Number(m[1], 10)));
}

function parseExamples(content) {
  const lines = content.split("\n");
  const examples = [];
  let currentHeading = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#### ")) {
      currentHeading = line.slice(5).trim();
      continue;
    }

    if (line.startsWith("### ")) {
      currentHeading = line.slice(4).trim();
      continue;
    }

    const fence = line.match(/^```(html|css)$/);
    if (!fence) continue;

    const lang = fence[1];
    const codeStart = i + 1;
    let j = codeStart;
    const codeLines = [];
    while (j < lines.length && !lines[j].startsWith("```")) {
      codeLines.push(lines[j]);
      j++;
    }
    if (j >= lines.length) continue;

    const codeEnd = j;
    const code = codeLines.join("\n");

    let hasSandbox = false;
    let sandboxSlug = null;
    let footnoteNum = null;

    for (let k = codeEnd + 1; k < Math.min(codeEnd + 25, lines.length); k++) {
      const edit = lines[k].match(
        /\[\!\[Edit (\d+)-([^\]]+)\]\(images\/codesandbox\.svg\)\]\(https:\/\/codesandbox\.io\/p\/sandbox\/([^)]+)\)/
      );
      if (edit) {
        hasSandbox = true;
        footnoteNum = Number(edit[1], 10);
        sandboxSlug = edit[3];
        break;
      }
    }

    examples.push({
      heading: currentHeading || "(no heading)",
      lang,
      code,
      codeStart,
      codeEnd,
      hasSandbox,
      footnoteNum,
      sandboxSlug,
    });

    i = codeEnd;
  }

  return examples;
}

function assignNumbers(examples, content) {
  let next = maxExistingNumber(content) + 1;
  return examples.map((ex) => {
    if (ex.hasSandbox) return { ...ex, number: ex.footnoteNum };
    return { ...ex, number: next++ };
  });
}

function setDocumentTitle(html, title) {
  const escaped = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escaped}</title>`);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n    <title>${escaped}</title>`);
  }
  return html;
}

function normalizeHtmlDocument(code, heading) {
  const isDocument =
    /^\s*<!DOCTYPE/i.test(code) || /^\s*<html[\s>]/i.test(code);
  const html = isDocument
    ? code
    : `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${heading}</title>
  </head>
  <body>
${code}
  </body>
</html>`;
  return setDocumentTitle(html, heading);
}

function findPrecedingHtmlExample(examples, example) {
  const idx = examples.indexOf(example);
  for (let i = idx - 1; i >= 0; i--) {
    if (examples[i].lang === "html") {
      return { example: examples[i], index: i };
    }
  }
  return null;
}

function collectCssBlocksSince(examples, fromIndex, toIndex) {
  return examples
    .slice(fromIndex + 1, toIndex + 1)
    .filter((ex) => ex.lang === "css")
    .map((ex) => ex.code);
}

function mergeCssIntoHtml(html, cssBlocks) {
  const css = cssBlocks.join("\n\n");
  const indented = css
    .split("\n")
    .map((line) => (line ? `      ${line}` : ""))
    .join("\n");
  const styleBlock = `\n    <style>\n${indented}\n    </style>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${styleBlock}\n  </head>`);
  }
  return `${styleBlock}\n${html}`;
}

function packageJsonFor(heading) {
  return {
    content: {
      name: slugify(heading).slice(0, 40) || "a11y-demo",
      main: "index.html",
    },
  };
}

function buildSandboxFiles(example, examples) {
  const { lang, code, heading } = example;

  if (lang === "html") {
    return {
      "index.html": { content: normalizeHtmlDocument(code, heading) },
      "package.json": packageJsonFor(heading),
    };
  }

  if (lang === "css") {
    const preceding = findPrecedingHtmlExample(examples, example);
    if (!preceding) {
      throw new Error(
        `CSS example #${example.number} has no preceding HTML block in README to merge with`
      );
    }

    return {
      "index.html": {
        content: buildMergedHtmlForCssExample(example, examples),
      },
      "package.json": packageJsonFor(heading),
    };
  }

  throw new Error(`Unsupported language: ${lang}`);
}

function buildMergedHtmlForCssExample(example, examples) {
  const preceding = findPrecedingHtmlExample(examples, example);
  if (!preceding) {
    throw new Error(
      `CSS example #${example.number} has no preceding HTML block in README to merge with`
    );
  }

  const idx = examples.indexOf(example);
  const cssBlocks = collectCssBlocksSince(examples, preceding.index, idx);
  const html = normalizeHtmlDocument(preceding.example.code, example.heading);

  return mergeCssIntoHtml(html, cssBlocks);
}

function expandCssExampleInReadme(content, example, examples) {
  if (example.lang !== "css") return content;

  const merged = buildMergedHtmlForCssExample(example, examples);
  const lines = content.split("\n");
  const fenceStart = example.codeStart - 1;
  const fenceEnd = example.codeEnd;
  lines.splice(fenceStart, fenceEnd - fenceStart + 1, "```html", merged, "```");
  return lines.join("\n");
}

function filesToApiPayload(files) {
  const apiFiles = {};
  for (const [filePath, file] of Object.entries(files)) {
    const content =
      typeof file.content === "string"
        ? file.content
        : JSON.stringify(file.content, null, 2);
    apiFiles[filePath] = {
      code: content,
      is_binary: false,
    };
  }
  return apiFiles;
}

function exampleTitle(example) {
  const num = String(example.number).padStart(3, "0");
  return `${num}-${example.heading}`;
}

async function apiRequest(apiKey, method, endpoint, body) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`CodeSandbox API ${response.status}: ${text}`);
  }

  if (!response.ok) {
    const message =
      data.errors?.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; ") ||
      text ||
      response.statusText;
    throw new Error(`CodeSandbox API ${response.status}: ${message}`);
  }

  return data;
}

async function verifyApiKey(apiKey, config) {
  const meta = await apiRequest(apiKey, "GET", "/meta/info");
  const workspace = meta.data?.workspace_name || meta.data?.team_name || "workspace";
  console.log(`API key OK — workspace: ${workspace}`);
  console.log(`Target folder: ${config.collectionPath}`);

  const list = await apiRequest(apiKey, "GET", "/sandbox?page_size=5&order_by=updated_at&direction=desc");
  const count = list.data?.pagination?.total_records ?? list.data?.sandboxes?.length ?? 0;
  console.log(`Sandboxes visible in workspace: ${count}`);
}

async function createAuthenticatedSandbox(apiKey, config, example, files) {
  const body = {
    title: exampleTitle(example),
    description: example.heading,
    template: config.template,
    runtime: config.runtime,
    entry: config.entry,
    path: config.collectionPath,
    privacy: config.privacy,
    files: filesToApiPayload(files),
  };

  const result = await apiRequest(apiKey, "POST", "/sandbox", body);
  const sandbox = result.data;
  if (!sandbox?.id) {
    throw new Error(`Unexpected API response: ${JSON.stringify(result)}`);
  }

  return {
    sandboxId: sandbox.id,
    alias: sandbox.alias,
    title: sandbox.title,
  };
}

async function createAnonymousSandbox(files) {
  const parameters = getParameters({ files });
  const response = await fetch(DEFINE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parameters }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Define API ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (!data.sandbox_id) {
    throw new Error(`Unexpected Define API response: ${JSON.stringify(data)}`);
  }
  return { sandboxId: data.sandbox_id, alias: null, title: null };
}

function formatMarkdown(example, sandboxId) {
  const num = String(example.number).padStart(3, "0");
  const title = example.heading;
  const slug = `${num}-${slugify(title)}-${sandboxId}`;
  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return [
    `[![Edit ${num}-${title}](images/codesandbox.svg)](https://codesandbox.io/p/sandbox/${slug})`,
    "",
    `[^${example.number}]CodeSandbox: ${title}.`,
    "",
    `[^${example.number}]:[CodeSandbox: ${title}](https://${sandboxId}.csb.app/), last access: ${today}.`,
    "",
  ].join("\n");
}

function insertAfterExample(content, example, markdown) {
  const lines = content.split("\n");
  const insertAt = example.codeEnd + 1;
  const block = `\n${markdown.trimEnd()}\n`;
  lines.splice(insertAt, 0, block);
  return lines.join("\n");
}

function replaceSandboxLinks(content, example, sandboxId) {
  const num = String(example.number).padStart(3, "0");
  const markdown = formatMarkdown(example, sandboxId).trim();
  const pattern = new RegExp(
    `\\[\\!\\[Edit ${num}-[\\s\\S]*?\\[\\^${example.number}\\]:\\[[^\\]]+\\]\\([^)]+\\), last access:[^\\n]+\\.`,
    "m"
  );
  if (pattern.test(content)) {
    return content.replace(pattern, markdown);
  }
  return insertAfterExample(content, example, markdown);
}

function recordSandbox(manifest, example, created, options, config) {
  const { sandboxId } = created;
  const slug = `${String(example.number).padStart(3, "0")}-${slugify(example.heading)}-${sandboxId}`;
  manifest.examples[String(example.number)] = {
    heading: example.heading,
    lang: example.lang,
    sandboxId,
    slug,
    alias: created.alias,
    collectionPath: options.anonymous ? null : config.collectionPath,
    editorUrl: `https://codesandbox.io/p/sandbox/${slug}`,
    previewUrl: `https://${sandboxId}.csb.app/`,
    updatedAt: new Date().toISOString(),
  };
  saveManifest(manifest);
  return { sandboxId, slug, markdown: formatMarkdown(example, sandboxId) };
}

function pickExamples(examples, options) {
  if (options.index != null) {
    const ex = examples.find((e) => e.number === options.index);
    if (!ex) throw new Error(`No example with index ${options.index}`);
    return [ex];
  }

  if (options.heading) {
    const needle = options.heading.toLowerCase();
    const matches = examples.filter((e) =>
      e.heading.toLowerCase().includes(needle)
    );
    if (matches.length === 0) {
      throw new Error(`No example heading matches "${options.heading}"`);
    }
    return matches;
  }

  if (options.next) {
    const missing = examples.filter((e) => !e.hasSandbox);
    if (missing.length === 0) throw new Error("All examples already have sandboxes");
    return [missing[0]];
  }

  if (options.allMissing) {
    return examples.filter((e) => !e.hasSandbox);
  }

  throw new Error('Specify --next, --index N, --heading "…", or --all-missing');
}

function printScan(examples) {
  const withSandbox = examples.filter((e) => e.hasSandbox).length;
  console.log(`Found ${examples.length} code examples (${withSandbox} with CodeSandbox links)\n`);

  for (const ex of examples) {
    const status = ex.hasSandbox ? `linked #${ex.footnoteNum}` : `missing → would be #${ex.number}`;
    console.log(
      `  #${String(ex.number).padStart(3, "0")}  [${ex.lang}]  ${status}  ${ex.heading}`
    );
  }
}

function printHelp() {
  const config = fs.existsSync(CONFIG_PATH) ? loadConfig() : null;
  console.log(`CodeSandbox helper for README.md

Commands:
  verify                       Test CSB_API_KEY and show target folder
  scan                         List examples and link status
  create [options]             Create sandbox(es) in your workspace folder
  insert [options]             Create sandbox(es) and patch README.md
  refresh [options]            Recreate sandbox from current README (updates links)
  expand-readme [options]    Replace CSS-only fences with full HTML in README.md

Auth (required for folder placement):
  export CSB_API_KEY="..."     From https://codesandbox.io/t/api
                               Scopes: sandbox_create, sandbox_edit_code

Options:
  --next                       First example without a link
  --index N                    Example by assigned number (e.g. 34)
  --heading "text"             Match #### heading substring
  --all-missing                Every example without a link
  --dry-run                    Show actions without API calls or file writes
  --anonymous                  Use public Define API (not in your folder)

Config: scripts/codesandbox.config.json
  collectionPath: ${config?.collectionPath ?? "(not loaded)"}
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const config = loadConfig();
  const apiKey = getApiKey();
  const useAnonymous = args.includes("--anonymous");

  const options = {
    index: null,
    heading: null,
    next: args.includes("--next"),
    allMissing: args.includes("--all-missing"),
    dryRun: args.includes("--dry-run"),
    anonymous: useAnonymous,
  };

  const indexArg = args.find((a) => a.startsWith("--index"));
  if (indexArg) {
    options.index = Number(indexArg.split("=")[1] ?? args[args.indexOf(indexArg) + 1], 10);
  }
  const headingArg = args.find((a) => a.startsWith("--heading"));
  if (headingArg) {
    options.heading = headingArg.split("=")[1] ?? args[args.indexOf(headingArg) + 1];
  }

  if (command === "verify") {
    if (!apiKey) {
      throw new Error("Set CSB_API_KEY first (https://codesandbox.io/t/api)");
    }
    await verifyApiKey(apiKey, config);
    return;
  }

  const content = fs.readFileSync(README, "utf8");
  let examples = assignNumbers(parseExamples(content), content);

  if (command === "scan") {
    printScan(examples);
    return;
  }

  if (command === "expand-readme") {
    const selected = pickExamples(examples, options);
    let readme = content;
    let changed = false;

    for (const example of selected) {
      if (example.lang !== "css") {
        console.log(`Skip #${example.number} (not a CSS fence): ${example.heading}`);
        continue;
      }
      if (options.dryRun) {
        console.log(`#${String(example.number).padStart(3, "0")}  would expand CSS → full HTML`);
        continue;
      }
      readme = expandCssExampleInReadme(readme, example, examples);
      changed = true;
      console.log(`#${String(example.number).padStart(3, "0")}  expanded CSS block to full HTML`);
    }

    if (changed && !options.dryRun) {
      fs.writeFileSync(README, readme);
      console.log("\nWrote README.md");
    }
    return;
  }

  if (command !== "create" && command !== "insert" && command !== "refresh") {
    throw new Error(`Unknown command: ${command}`);
  }

  if (!options.anonymous && !apiKey) {
    throw new Error(
      "Set CSB_API_KEY to create sandboxes in your folder (https://codesandbox.io/t/api), or pass --anonymous"
    );
  }

  const selected = pickExamples(examples, options);
  const manifest = loadManifest();
  let readme = content;
  const isRefresh = command === "refresh";
  const targetNumbers = selected.map((e) => e.number);

  for (const targetNumber of targetNumbers) {
    examples = assignNumbers(parseExamples(readme), readme);
    let example = examples.find((e) => e.number === targetNumber);
    if (!example) {
      console.log(`Skip #${targetNumber} (not found after README updates)`);
      continue;
    }

    if (example.hasSandbox && !isRefresh) {
      console.log(`Skip #${example.number} (already linked): ${example.heading}`);
      continue;
    }

    const files = buildSandboxFiles(example, examples);
    const mode = options.anonymous ? "anonymous Define API" : `folder: ${config.collectionPath}`;
    console.log(`\n#${String(example.number).padStart(3, "0")}  ${example.heading}  [${example.lang}]`);
    console.log(`  via ${mode}`);
    if (example.lang === "css") {
      const preceding = findPrecedingHtmlExample(examples, example);
      if (preceding) {
        const cssCount = collectCssBlocksSince(
          examples,
          preceding.index,
          examples.indexOf(example)
        ).length;
        console.log(
          `  full index.html: HTML from #${String(preceding.example.number).padStart(3, "0")} + ${cssCount} CSS block(s) from README`
        );
      }
    }

    if (options.dryRun) {
      console.log(`  dry-run: would ${isRefresh ? "refresh" : "create"} sandbox`);
      console.log(formatMarkdown(example, "xxxxxxxx"));
      continue;
    }

    const previousId = manifest.examples[String(example.number)]?.sandboxId;
    const created = options.anonymous
      ? await createAnonymousSandbox(files)
      : await createAuthenticatedSandbox(apiKey, config, example, files);

    const { sandboxId, slug, markdown } = recordSandbox(
      manifest,
      example,
      created,
      options,
      config
    );

    console.log(`  created: https://codesandbox.io/p/sandbox/${slug}`);
    console.log(`  preview: https://${sandboxId}.csb.app/`);
    if (!options.anonymous) {
      console.log(`  folder:  ${config.collectionPath}`);
    }
    if (isRefresh && previousId && previousId !== sandboxId) {
      console.log(`  note:    delete old sandbox ${previousId} from dashboard if you like`);
    }

    if (command === "insert" || command === "refresh") {
      if (example.lang === "css" && !options.dryRun) {
        readme = expandCssExampleInReadme(readme, example, examples);
        examples = assignNumbers(parseExamples(readme), readme);
        example = examples.find((e) => e.number === example.number) || example;
        console.log("  expanded CSS block to full HTML in README.md");
      }

      if (!options.dryRun) {
        if (command === "insert") {
          readme = insertAfterExample(readme, example, markdown);
          example.hasSandbox = true;
          console.log("  inserted markdown into README.md");
        } else {
          readme = replaceSandboxLinks(readme, example, sandboxId);
          console.log("  updated markdown in README.md");
        }
      }
    } else if (!options.dryRun) {
      console.log("\nPaste after the code block:\n");
      console.log(markdown);
    }
  }

  if ((command === "insert" || command === "refresh") && !options.dryRun) {
    fs.writeFileSync(README, readme);
    console.log("\nWrote README.md");
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
