// functions/upload.js

// --- IMPORTS ---
const AdmZip = require("adm-zip");
const { Redis } = require("@upstash/redis");

// --- DATABASE SETUP ---
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// --- CONSTANTS ---
const MAX_SCANS_PER_MONTH = 3;
const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

// --- MAIN HANDLER FUNCTION ---
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    // Always return errors as JSON
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // --- DATABASE-DRIVEN RATE LIMITING ---
  const ip = event.headers['x-nf-client-connection-ip'] || 'anonymous';
  let count = await redis.get(ip);
  count = count ? parseInt(count, 10) : 0;

  if (count >= MAX_SCANS_PER_MONTH) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: "You have reached your free scan limit. Please upgrade to Pro." }),
    };
  }

  // --- SIMPLIFIED FILE HANDLING ---
  if (!event.body || !event.isBase64Encoded) {
    return { statusCode: 400, body: JSON.stringify({ error: "No file data received. Please upload a valid .zip file." }) };
  }

  // Netlify provides the uploaded file body as a base64 encoded string.
  // We just need to convert it back to a binary buffer.
  const zipBuffer = Buffer.from(event.body, "base64");

  const detectedKeys = [];

  try {
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();

    zipEntries.forEach((zipEntry) => {
      // Ignore directories
      if (zipEntry.isDirectory) {
        return;
      }
      
      let content = zip.readAsText(zipEntry);
      
      // A more robust regex to find potential keys
      const regex = /(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
      let match;
      while ((match = regex.exec(content)) !== null) {
          detectedKeys.push(match[0].length > 30 ? `${match[0].substring(0, 10)}...` : match[0]); // Push a truncated key for display
      }
    });

  } catch (err) {
    console.error("Error processing zip file:", err);
    return { statusCode: 400, body: JSON.stringify({ error: "Could not process the uploaded .zip file. It may be corrupt or in an invalid format." }) };
  }

  // --- UPDATE DATABASE COUNT ---
  await redis.set(ip, count + 1, { px: ONE_MONTH_IN_MS });

  // --- SUCCESS RESPONSE ---
  // Note: We are no longer modifying and re-zipping the file in this simplified version.
  // We are just scanning it, which is the core goal.
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keys: detectedKeys,
      message: `Scan complete! Found ${detectedKeys.length} potential keys.`,
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1)
    })
  };
};