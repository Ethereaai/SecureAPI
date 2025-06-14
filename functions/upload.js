// functions/upload.js

const { Redis } = require("@upstash/redis");
const AdmZip = require("adm-zip");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_SCANS_PER_MONTH = 3;
const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

const REDACTION_STRING = "***REDACTED_BY_SECUREAPI***";

const README_CONTENT = `# Your Project Has Been Secured by SecureAPI! 🛡️

We've moved your hard-coded API keys and secrets into a new \`.env\` file where possible.

## What We Did
1. **Refactored keys** found in your source (e.g. \`const myKey = "…"\`) into environment variables.
2. **Redacted** anything that looked like a secret but couldn't be moved automatically (like email addresses or keys in other contexts).

## Your Next Steps
1. **Install dotenv:** In your terminal, run \`npm install dotenv\`.
2. **Load variables:** Add \`require('dotenv').config();\` to the very top of your application's main script.
3. **Handle Redacted Secrets:** Manually move any redacted secrets from your source code into the \`.env\` file.
4. **Gitignore:** Make sure your \`.env\` file is listed in your \`.gitignore\` file to keep it private.

Happy (and safe) shipping!
`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const ip = event.headers["x-nf-client-connection-ip"] || "anonymous";
  const count = parseInt((await redis.get(ip)) || "0", 10);

  if (count >= MAX_SCANS_PER_MONTH) {
    return { statusCode: 429, body: JSON.stringify({ error: "You have reached your free scan limit." }) };
  }

  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: "No file data received." }) };
  }

  let zipBuffer;
  try {
    const { fileData } = JSON.parse(event.body);
    zipBuffer = Buffer.from(fileData, "base64");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request format." }) };
  }

  const envVars = {};
  const redactedSet = new Set();
  const securedZip = new AdmZip();

  try {
    const srcZip = new AdmZip(zipBuffer);
    const secretRegex = /(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{24,}|AKIA[0-9A-Z]{16}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|(?<![A-Z0-9])[A-Z0-9]{20,}(?![A-Z0-9]))/gi;
    const assignmentRegex = /(const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*[`'"]\s*?(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{24,}|AKIA[0-9A-Z]{16}|(?<![A-Z0-9])[A-Z0-9]{20,}(?![A-Z0-9]))\s*?[`'"]/gi;

    srcZip.getEntries().forEach((entry) => {
      if (entry.isDirectory) {
        securedZip.addFile(entry.entryName, Buffer.alloc(0), "", entry.attr);
        return;
      }

      const originalContent = srcZip.readAsText(entry, "utf8");

      // PASS 1: Refactor keys that are assigned to variables
      const refactoredContent = originalContent.replace(assignmentRegex, (match, declaration, varName, secret) => {
        const envName = varName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
        envVars[envName] = secret;
        return `${declaration} ${varName} = process.env.${envName};`;
      });

      // PASS 2: Redact any remaining secrets (emails or keys not in assignments)
      const finalContent = refactoredContent.replace(secretRegex, (match) => {
        // Always redact emails
        if (match.includes("@")) {
          redactedSet.add(`${match.slice(0, 15)}...`);
          return REDACTION_STRING;
        }

        // Redact API keys only if they haven't already been refactored
        if (!Object.values(envVars).includes(match)) {
          redactedSet.add(`${match.slice(0, 15)}...`);
          return REDACTION_STRING;
        }
        
        // If the key was refactored, it no longer exists in plain text, so this match is safe to ignore
        return match; 
      });

      securedZip.addFile(entry.entryName, Buffer.from(finalContent, "utf8"));
    });

    const envContent = Object.keys(envVars).length
      ? Object.entries(envVars).map(([k, v]) => `${k}="${v}"`).join("\n")
      : "# No secrets were automatically extracted. Add any redacted secrets here.\n# EXAMPLE: MY_API_KEY=\"value\"\n";

    securedZip.addFile(".env", Buffer.from(envContent, "utf8"));
    securedZip.addFile("README-SECUREAPI.md", Buffer.from(README_CONTENT, "utf8"));

  } catch (err) {
    console.error("Zip-processing error:", err);
    return { statusCode: 400, body: JSON.stringify({ error: "Could not process the .zip file." }) };
  }

  await redis.set(ip, count + 1, { px: ONE_MONTH_IN_MS });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refactoredKeys: Object.keys(envVars),
      redactedKeys: Array.from(redactedSet),
      downloadData: securedZip.toBuffer().toString("base64"),
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1),
    }),
  };
};