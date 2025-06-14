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
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // --- RATE LIMITING ---
  const ip = event.headers['x-nf-client-connection-ip'] || 'anonymous';
  let count = await redis.get(ip) || 0;

  if (count >= MAX_SCANS_PER_MONTH) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: "You have reached your free scan limit. Please upgrade to Pro." }),
    };
  }

  // --- FILE HANDLING ---
  if (!event.body || !event.isBase64Encoded) {
    return { statusCode: 400, body: JSON.stringify({ error: "No file data received." }) };
  }

  const zipBuffer = Buffer.from(event.body, "base64");
  const detectedKeys = [];
  
  // Create a NEW zip object in memory to hold the secured files
  const newZip = new AdmZip();

  try {
    const originalZip = new AdmZip(zipBuffer);
    const zipEntries = originalZip.getEntries();

    zipEntries.forEach((zipEntry) => {
      // If it's a directory, just add it to the new zip and continue
      if (zipEntry.isDirectory) {
        newZip.addFile(zipEntry.entryName, Buffer.alloc(0), '', zipEntry.attr);
        return;
      }
      
      let content = originalZip.readAsText(zipEntry);
      
      // THIS IS THE UPGRADED BLOCK YOU IDENTIFIED
      // The powerful regex to find various keys
      const regex = /(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|AKIA[0-9A-Z]{16}|(?<![A-Z0-9])[A-Z0-9]{20,}(?![A-Z0-9]))/gi;

      // Replace the found keys and store them in our list
      const securedContent = content.replace(regex, (match) => {
        detectedKeys.push(match.length > 30 ? `${match.substring(0, 10)}...` : match);
        return '***REDACTED_BY_SECUREAPI***';
      });

      // Add the secured file content to our new zip
      newZip.addFile(zipEntry.entryName, Buffer.from(securedContent, "utf8"));
    });

  } catch (err) {
    console.error("Error processing zip file:", err);
    return { statusCode: 400, body: JSON.stringify({ error: "Could not process the .zip file." }) };
  }
  
  // Convert our new, secure zip file to a base64 string for download
  const downloadData = newZip.toBuffer().toString("base64");

  // --- UPDATE DATABASE COUNT ---
  await redis.set(ip, count + 1, { px: ONE_MONTH_IN_MS });

  // --- SUCCESS RESPONSE ---
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keys: detectedKeys,
      downloadData: downloadData, // The actual data for the download button
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1)
    })
  };
};