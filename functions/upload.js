// functions/upload.js

const { Redis } = require("@upstash/redis");
const AdmZip = require("adm-zip");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_SCANS_PER_MONTH = 3;
const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

// Helper function to escape special characters for use in a RegExp
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const readmeContent = `# Your Project Has Been Secured by SecureAPI!

We've moved your hardcoded API keys and secrets into a new '.env' file where possible.

## What We Did:

1.  **Refactored Keys:** For any API key we found assigned to a variable (e.g., \`const myKey = "..."\`), we moved it to the new \`.env\` file and updated your code to use \`process.env.MY_KEY\`.

2.  **Redacted Secrets:** We replaced the following with \`***REDACTED_BY_SECUREAPI***\`:
    *   Any email addresses.
    *   Any API keys we couldn't automatically refactor.

## Required Steps:

1.  **Install 'dotenv':** Run \`npm install dotenv\` in your project.
2.  **Load Variables:** Add \`require('dotenv').config();\` to the top of your main script.

**IMPORTANT:** Add the '.env' file to your '.gitignore' to prevent committing it.
`;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const ip = event.headers['x-nf-client-connection-ip'] || 'anonymous';
  const count = parseInt(await redis.get(ip) || 0, 10);

  if (count >= MAX_SCANS_PER_MONTH) {
    return { statusCode: 429, body: JSON.stringify({ error: "You have reached your free scan limit." }) };
  }
  
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: "No file data received." }) };
  }

  let zipBuffer;
  try {
    zipBuffer = Buffer.from(JSON.parse(event.body).fileData, "base64");
  } catch (parseError) {
    return { statusCode: 400, body: JSON.stringify({ error: `Invalid request format.` }) };
  }

  const environmentVariables = {};
  const redactedSecrets = new Set();
  const newZip = new AdmZip();
  const redactionString = '***REDACTED_BY_SECUREAPI***';

  try {
    const originalZip = new AdmZip(zipBuffer);
    const regex = /(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|AKIA[0-9A-Z]{16}|(?<![A-Z0-9])[A-Z0-9]{20,}(?![A-Z0-9]))/gi;

    originalZip.getEntries().forEach((zipEntry) => {
      if (zipEntry.isDirectory) {
        newZip.addFile(zipEntry.entryName, Buffer.alloc(0), '', zipEntry.attr);
        return;
      }
      let content = originalZip.readAsText(zipEntry, "utf8");
      let refactoredContent = content;
      
      // PASS 1: Smart Refactor (only for API keys, not emails)
      refactoredContent = content.replace(/(const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*['"](sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|(?<![A-Z0-9])[A-Z0-9]{20,}(?![A-Z0-9]))['"]/gi, (match, declaration, varName, secret) => {
        const envVarName = varName.replace(/([A-Z])/g, '_$1').toUpperCase();
        environmentVariables[envVarName] = secret;
        return `${declaration} ${varName} = process.env.${envVarName};`;
      });
      
      // PASS 2: Aggressive Redaction (for everything)
      let finalContent = refactoredContent.replace(regex, (match) => {
        if (match.includes('@')) {
          // Always redact emails
          redactedSecrets.add(`${match.substring(0, 15)}...`);
          return redactionString;
        } else {
          // Redact API Keys, but only if they weren't already refactored
          if (!Object.values(environmentVariables).includes(match)) {
            redactedSecrets.add(`${match.substring(0, 15)}...`);
            return redactionString;
          }
          return match; // Leave it alone, it was refactored!
        }
      });

      newZip.addFile(zipEntry.entryName, Buffer.from(finalContent, "utf8"));
    });

    const hasSecrets = Object.keys(environmentVariables).length > 0 || redactedSecrets.size > 0;

    if (hasSecrets) {
      const envContent = Object.keys(environmentVariables).length > 0 
        ? Object.entries(environmentVariables).map(([key, value]) => `${key}="${value}"`).join('\n')
        : `# Add your redacted keys here. For example:\n# MY_SECRET_PASSWORD="value_of_redacted_key"\n`;
        
      newZip.addFile('.env', Buffer.from(envContent, "utf8"));
      newZip.addFile('README-SECUREAPI.md', Buffer.from(readmeContent, "utf8"));
    }

  } catch (err) {
    console.error("Error processing zip file:", err);
    return { statusCode: 400, body: JSON.stringify({ error: "Could not process the .zip file." }) };
  }
  
  const downloadData = newZip.toBuffer().toString("base64");
  await redis.set(ip, count + 1, { px: ONE_MONTH_IN_MS });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refactoredKeys: Object.keys(environmentVariables),
      redactedKeys: Array.from(redactedSecrets),
      downloadData: downloadData,
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1)
    })
  };
};