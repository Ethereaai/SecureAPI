// functions/upload.js

const { Redis } = require("@upstash/redis");
const AdmZip = require("adm-zip");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_SCANS_PER_MONTH = 3;
const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

const readmeContent = `# Your Project Has Been Secured by SecureAPI!

We've moved your hardcoded API keys and secrets into a new '.env' file where possible.

## What We Did:

1.  **Refactored Keys:** For any key we found assigned to a variable (e.g., \`const myKey = "..."\`), we moved it to the new \`.env\` file and updated your code to use \`process.env.MY_KEY\`. You just need to install a package to read the .env file.

2.  **Redacted Keys:** For any other long, secret-looking strings that we couldn't automatically refactor, we replaced them with \`***REDACTED_BY_SECUREAPI***\`. This prevents them from being exposed. You will need to review these and handle them manually, perhaps by creating a new entry in the .env file for them.

## Required Steps:

1.  **Install the 'dotenv' package:**
    Open your terminal in the project directory and run:
    \`\`\`bash
    npm install dotenv
    \`\`\`

2.  **Load the environment variables:**
    At the very top of your application's main entry file (e.g., index.js, app.js), add the following line:
    \`\`\`javascript
    require('dotenv').config();
    \`\`\`

That's it! Your application will now securely load the refactored keys.

**IMPORTANT:** Remember to add the '.env' file to your '.gitignore' to prevent it from being committed to your repository.
`;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const ip = event.headers['x-nf-client-connection-ip'] || 'anonymous';
  const count = parseInt(await redis.get(ip) || 0, 10);

  if (count >= MAX_SCANS_PER_MONTH) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: "You have reached your free scan limit. Please upgrade to Pro." }),
    };
  }
  
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: "No file data received." }) };
  }

  let zipBuffer;
  try {
    const requestBody = JSON.parse(event.body);
    zipBuffer = Buffer.from(requestBody.fileData, "base64");
  } catch (parseError) {
    return { statusCode: 400, body: JSON.stringify({ error: `Invalid request format: ${parseError.message}` }) };
  }

  const environmentVariables = {};
  const redactedKeys = new Set();
  const newZip = new AdmZip();

  try {
    const originalZip = new AdmZip(zipBuffer);
    
    // --- THE FIX IS HERE: Include hyphen in the key pattern ---
    const keyPattern = "([a-zA-Z0-9_-]{20,})"; // Added hyphen to the character class
    // --- END OF FIX ---
    
    const refactorRegex = new RegExp(`(const|let|var)\\s+([a-zA-Z0-9_]+)\\s*=\\s*['"]${keyPattern}['"]`, 'gi');
    const redactRegex = new RegExp(keyPattern, 'g');

    originalZip.getEntries().forEach((zipEntry) => {
      if (zipEntry.isDirectory) {
        newZip.addFile(zipEntry.entryName, Buffer.from(0), '', zipEntry.attr); // Corrected: Buffer.alloc(0) or Buffer.from('')
        return;
      }
      let content = originalZip.readAsText(zipEntry);
      
      let refactoredContent = content.replace(refactorRegex, (match, declaration, varName, secret) => {
        const envVarName = varName.replace(/([A-Z])/g, '_$1').toUpperCase();
        environmentVariables[envVarName] = secret;
        return `${declaration} ${varName} = process.env.${envVarName};`;
      });

      let finalContent = refactoredContent.replace(redactRegex, (key) => {
        // Ensure we don't try to redact something that was already handled by refactoring
        // This check is a bit simplistic but helps avoid double-processing in some edge cases.
        // A more robust way would be to track exact positions, but this is a good heuristic.
        if (Object.values(environmentVariables).includes(key)) {
            return key; // If it was refactored, leave it as is (it's now process.env.VAR)
        }
        redactedKeys.add(`${key.substring(0, 15)}...`);
        return `***REDACTED_BY_SECUREAPI***`;
      });

      newZip.addFile(zipEntry.entryName, Buffer.from(finalContent, "utf8"));
    });

    if (Object.keys(environmentVariables).length > 0) {
      const envContent = Object.entries(environmentVariables)
        .map(([key, value]) => `${key}="${value}"`)
        .join('\n');
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
      redactedKeys: Array.from(redactedKeys),
      downloadData: downloadData,
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1)
    })
  };
};