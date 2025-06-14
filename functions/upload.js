// functions/upload.js

// --- MERGED IMPORTS ---
// Your existing file-handling imports
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
// Our new database import
const { Redis } = require("@upstash/redis");

// --- DATABASE SETUP ---
// Connect to Upstash Redis using the environment variables from your Netlify settings
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// --- CONSTANTS ---
const MAX_SCANS_PER_MONTH = 3; // Using your variable, which is great!
const ONE_MONTH_IN_MS = 30 * 24 * 60 * 60 * 1000;

// --- MAIN HANDLER FUNCTION ---
exports.handler = async function (event) {
  // Check if the request method is POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // --- NEW DATABASE-DRIVEN RATE LIMITING ---
  // Get the user's IP address from Netlify's headers
  const ip = event.headers['x-nf-client-connection-ip'] || 'anonymous';
  
  // Get the current scan count for this IP from Redis. It will be null if they've never visited.
  let count = await redis.get(ip);
  count = count ? parseInt(count, 10) : 0; // If null, the count is 0.

  // Check if the user is over their limit
  if (count >= MAX_SCANS_PER_MONTH) {
    return {
      statusCode: 429, // Using 429 for "Too Many Requests" is more standard
      body: JSON.stringify({
        error: "You have reached your free scan limit. Please upgrade to Pro.",
      }),
    };
  }

  // --- YOUR EXISTING FILE PROCESSING LOGIC (UNCHANGED) ---
  // This part is perfect, so we keep it exactly as it is.
  const boundary = event.headers["content-type"].split("boundary=")[1];
  const body = Buffer.from(event.body, "base64");
  const parts = body.toString().split(`--${boundary}`);

  const zipPart = parts.find((p) => p.includes("filename="));
  if (!zipPart) {
    return { statusCode: 400, body: "No file uploaded" };
  }

  const rawFile = zipPart.split("\r\n\r\n")[1];
  const zipBuffer = Buffer.from(rawFile, "binary");

  const tempDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(tempDir);

  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(tempDir, true);

  const detectedKeys = [];

  const walkDir = (dir) => {
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath);
      } else {
        let content = fs.readFileSync(fullPath, "utf8");
        const regex = /(sk-[a-zA-Z0-9]{32,}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
        if (regex.test(content)) {
          content = content.replace(regex, (match) => {
            detectedKeys.push(match);
            return '***REDACTED***';
          });
          fs.writeFileSync(fullPath, content);
        }
      }
    });
  };

  walkDir(tempDir);

  const outZip = new AdmZip();
  outZip.addLocalFolder(tempDir);
  const outputFile = path.join(os.tmpdir(), uuidv4() + ".zip");
  outZip.writeZip(outputFile);

  const outputBase64 = fs.readFileSync(outputFile).toString("base64");
  
  // --- END OF YOUR LOGIC ---

  // --- UPDATE DATABASE COUNT ---
  // If the scan was successful, we now increment their count in the database.
  // 'px' sets an expiration time in milliseconds, so their count automatically resets after 1 month.
  await redis.set(ip, count + 1, { px: ONE_MONTH_IN_MS });

  // --- SUCCESS RESPONSE ---
  // We send back everything the frontend needs: the keys, the file data, and their remaining scans.
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      keys: detectedKeys,
      downloadData: outputBase64, // The base64-encoded zip file
      remainingScans: MAX_SCANS_PER_MONTH - (count + 1)
    })
  };
};