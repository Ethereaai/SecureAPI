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

We've moved your hardcoded API keys and secrets into a new '.env' file.

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

That's it! Your application will now securely load keys from the '.env' file instead of having them exposed in your code.

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
  const warnings = new Set(); // Use a Set to avoid duplicate warnings
  const newZip = new AdmZip();

  try {
    const originalZip = new AdmZip(zipBuffer);
    
    // Regex for keys assigned to variables (for refactoring)
    const refactorRegex = /(const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*['"]((?:sk|pk_live)_[a-zA-Z0-9]{40,}|AKIA[0-9A-Z]{16})['"]/gi;
    
    // Regex for any other suspicious keys (for warnings)
    const warningRegex = /(?:['"]|[^a-zA-Z0-9])((sk|pk_live)_[a-zA-Z0-9]{40,}|AKIA[0-9A-Z]{16})(?:['"]|[^a-zA-Z0-9])/gi;

    originalZip.getEntries().forEach((zipEntry) => {
      if (zipEntry.isDirectory) {
        newZip.addFile(zipEntry.entryName, Buffer.alloc(0), '', zipEntry.attr);
        return;
      }
      let content = originalZip.readAsText(zipEntry);

      // --- PASS 1: Refactor what we can ---
      let securedContent = content.replace(refactorRegex, (match, declaration, varName, secret) => {
        const envVarName = varName.replace(/([A-Z])/g, '_$1').toUpperCase();
        environmentVariables[envVarName] = secret;
        return `${declaration} ${varName} = process.env.${envVarName};`;
      });

      // --- PASS 2: Find other keys and add warnings ---
      let match;
      while ((match = warningRegex.exec(securedContent)) !== null) {
         // Add a truncated version to the warnings
         warnings.add(`${match[1].substring(0, 15)}...`);
      }

      newZip.addFile(zipEntry.entryName, Buffer.from(securedContent, "utf8"));
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
  
  const refactoredKeys = Object.keys(environmentVariables);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keys: refactoredKeys,
      warnings: Array.from(warnings), // Convert Set to Array for JSON
      downloadData: downloadData,
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1)
    })
  };
};