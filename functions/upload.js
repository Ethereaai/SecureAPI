// functions/upload.js

const { Redis } = require("@upstash/redis");
const AdmZip = require("adm-zip");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_SCANS_PER_MONTH = 3;
const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

// This is the new instruction file content
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
    if (!requestBody.fileData) {
      return { statusCode: 400, body: JSON.stringify({ error: "No file data in request." }) };
    }
    zipBuffer = Buffer.from(requestBody.fileData, "base64");
  } catch (parseError) {
    return { statusCode: 400, body: JSON.stringify({ error: `Invalid request format: ${parseError.message}` }) };
  }

  // --- START OF NEW LOGIC ---
  const environmentVariables = {};
  const newZip = new AdmZip();

  try {
    const originalZip = new AdmZip(zipBuffer);
    
    // This more powerful regex captures the variable name and the secret.
    // Group 1: 'const', 'let', or 'var'
    // Group 2: The variable name (e.g., 'openAIKey')
    // Group 3: The secret value itself
    const secretRegex = /(const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*['"]((?:sk|pk_live)_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16})['"]/gi;

    originalZip.getEntries().forEach((zipEntry) => {
      if (zipEntry.isDirectory) {
        newZip.addFile(zipEntry.entryName, Buffer.alloc(0), '', zipEntry.attr);
        return;
      }
      let content = originalZip.readAsText(zipEntry);

      // We now refactor the code instead of just redacting it
      const securedContent = content.replace(secretRegex, (match, declaration, varName, secret) => {
        // Best practice: ENV_VAR_NAMES are in uppercase
        const envVarName = varName.replace(/([A-Z])/g, '_$1').toUpperCase();
        environmentVariables[envVarName] = secret;
        
        // Return the refactored line of code
        return `${declaration} ${varName} = process.env.${envVarName};`;
      });

      newZip.addFile(zipEntry.entryName, Buffer.from(securedContent, "utf8"));
    });

    // If we found any secrets, create the .env file and a helpful README
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
  
  // Return the names of the environment variables we created for a better success message
  const createdEnvVars = Object.keys(environmentVariables);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keys: createdEnvVars, // Now sending the ENV_VAR names
      downloadData: downloadData,
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1)
    })
  };
};