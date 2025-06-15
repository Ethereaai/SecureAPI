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
    
    // Enhanced regex patterns for better secret detection
    const secretPatterns = [
      // OpenAI API keys
      /sk-[a-zA-Z0-9]{20,}/g,
      // Stripe keys  
      /pk_live_[a-zA-Z0-9]{24,}/g,
      /sk_live_[a-zA-Z0-9]{24,}/g,
      // AWS keys
      /AKIA[0-9A-Z]{16}/g,
      // Generic long alphanumeric strings (potential API keys)
      /(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g,
      // Email addresses
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      // Common password patterns in assignments
      /(?:password|pass|pwd|secret|key|token|auth)\s*[=:]\s*[`'"]\s*([^`'"]{8,})\s*[`'"]/gi,
      // JWT tokens
      /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
      // MongoDB connection strings
      /mongodb(?:\+srv)?:\/\/[^\s"']+/g,
      // Database URLs
      /(?:postgres|mysql|redis):\/\/[^\s"']+/g
    ];

    // More comprehensive assignment regex
    const assignmentRegex = /(const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*[`'"]\s*?(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{24,}|sk_live_[a-zA-Z0-9]{24,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*|mongodb(?:\+srv)?:\/\/[^\s"']+|(?:postgres|mysql|redis):\/\/[^\s"']+|[A-Za-z0-9]{32,})\s*?[`'"]/gi;

    // Process each file in the zip
    srcZip.getEntries().forEach((entry) => {
      if (entry.isDirectory) {
        securedZip.addFile(entry.entryName, Buffer.alloc(0), "", entry.attr);
        return;
      }

      // Skip binary files and common non-text files
      const skipExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so'];
      const isTextFile = !skipExtensions.some(ext => entry.entryName.toLowerCase().endsWith(ext));
      
      if (!isTextFile) {
        securedZip.addFile(entry.entryName, entry.getData());
        return;
      }

      let originalContent;
      try {
        originalContent = srcZip.readAsText(entry, "utf8");
      } catch (error) {
        // If we can't read as text, treat as binary
        securedZip.addFile(entry.entryName, entry.getData());
        return;
      }

      let processedContent = originalContent;
      
      // PASS 1: Refactor keys that are assigned to variables
      processedContent = processedContent.replace(assignmentRegex, (match, declaration, varName, secret) => {
        // Generate environment variable name from variable name
        const envName = varName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
        
        // Add special prefixes for common types
        let finalEnvName = envName;
        if (secret.startsWith('sk-')) {
          finalEnvName = envName.includes('OPENAI') ? envName : `OPENAI_${envName}`;
        } else if (secret.startsWith('pk_live_') || secret.startsWith('sk_live_')) {
          finalEnvName = envName.includes('STRIPE') ? envName : `STRIPE_${envName}`;
        } else if (secret.startsWith('AKIA')) {
          finalEnvName = envName.includes('AWS') ? envName : `AWS_${envName}`;
        }
        
        envVars[finalEnvName] = secret;
        return `${declaration} ${varName} = process.env.${finalEnvName};`;
      });

      // PASS 2: Handle other assignment patterns (like password = "...")
      const passwordAssignmentRegex = /(const|let|var)\s+([a-zA-Z0-9_$]*(?:password|pass|pwd|secret|key|token|auth)[a-zA-Z0-9_$]*)\s*=\s*[`'"]\s*([^`'"]{6,})\s*[`'"]/gi;
      processedContent = processedContent.replace(passwordAssignmentRegex, (match, declaration, varName, secret) => {
        const envName = varName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
        envVars[envName] = secret;
        return `${declaration} ${varName} = process.env.${envName};`;
      });

      // PASS 3: Redact any remaining secrets using all patterns
      secretPatterns.forEach(pattern => {
        processedContent = processedContent.replace(pattern, (match) => {
          // Don't redact if it's already been refactored into an env var
          if (Object.values(envVars).includes(match)) {
            return match; // Keep the original since it should now be process.env.SOMETHING
          }
          
          // Always redact emails
          if (match.includes("@")) {
            redactedSet.add(`${match.slice(0, 15)}...`);
            return REDACTION_STRING;
          }
          
          // Don't redact very short strings or common words
          if (match.length < 8) {
            return match;
          }
          
          // Don't redact if it looks like a common word or path
          if (/^[a-z]+$/i.test(match) || match.includes('/') || match.includes('\\')) {
            return match;
          }
          
          redactedSet.add(`${match.slice(0, 15)}...`);
          return REDACTION_STRING;
        });
      });

      securedZip.addFile(entry.entryName, Buffer.from(processedContent, "utf8"));
    });

    // Create .env file with all extracted variables
    let envContent = "";
    if (Object.keys(envVars).length > 0) {
      envContent = Object.entries(envVars)
        .map(([key, value]) => `${key}="${value}"`)
        .join("\n") + "\n";
    } else {
      envContent = "# No secrets were automatically extracted. Add any redacted secrets here.\n# EXAMPLE: MY_API_KEY=\"value\"\n";
    }

    // Always add the .env file and README
    securedZip.addFile(".env", Buffer.from(envContent, "utf8"));
    securedZip.addFile("README-SECUREAPI.md", Buffer.from(README_CONTENT, "utf8"));

  } catch (err) {
    console.error("Zip-processing error:", err);
    return { statusCode: 400, body: JSON.stringify({ error: "Could not process the .zip file." }) };
  }

  // Increment scan counter
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