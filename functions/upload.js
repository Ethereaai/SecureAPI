// functions/upload.js

const { Redis } = require("@upstash/redis");
const AdmZip = require("adm-zip");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_SCANS_PER_MONTH = 3;
const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // --- THE DEFINITIVE FIX IS HERE ---
  const ip = event.headers['x-nf-client-connection-ip'] || 'anonymous';
  
  // We now use parseInt() to GUARANTEE the count is a number.
  const count = parseInt(await redis.get(ip) || 0, 10);

  if (count >= MAX_SCANS_PER_MONTH) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: "You have reached your free scan limit. Please upgrade to Pro." }),
    };
  }

  // --- FILE HANDLING LOGIC (This was already correct) ---
  if (!event.body || !event.isBase64Encoded) {
    return { statusCode: 400, body: JSON.stringify({ error: "No file data received." }) };
  }

  const zipBuffer = Buffer.from(event.body, "base64");
  const detectedKeys = [];
  const newZip = new AdmZip();

  try {
    const originalZip = new AdmZip(zipBuffer);
    originalZip.getEntries().forEach((zipEntry) => {
      if (zipEntry.isDirectory) {
        newZip.addFile(zipEntry.entryName, Buffer.alloc(0), '', zipEntry.attr);
        return;
      }
      let content = originalZip.readAsText(zipEntry);
      const regex = /(sk-[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|AKIA[0-9A-Z]{16}|(?<![A-Z0-9])[A-Z0-9]{20,}(?![A-Z0-9]))/gi;
      const securedContent = content.replace(regex, (match) => {
        detectedKeys.push(.length > 30 ? `${match.substring(0, 10)}...` : match);
        return '***REDACTED_BY_SECUREAPI***';
      });
      newZip.addFile(zipEntry.entryName, Buffer.from(securedContent, "utf8"));
    });
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
      keys: detectedKeys,
      downloadData: downloadData,
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1)
    })
  };
};