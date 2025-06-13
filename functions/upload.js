const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

const scanLimits = {};
const MAX_SCANS_PER_MONTH = 3;
const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const ip = event.headers['x-forwarded-for'] || 'anonymous';
  const now = Date.now();

  if (!scanLimits[ip] || now > scanLimits[ip].reset) {
    scanLimits[ip] = { count: 0, reset: now + ONE_MONTH };
  }

  if (scanLimits[ip].count >= MAX_SCANS_PER_MONTH) {
    return {
      statusCode: 402,
      body: JSON.stringify({
        message: "Free scan limit reached",
        redirect: "/.netlify/functions/checkout"
      })
    };
  }

  scanLimits[ip].count++;

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
        const regex = /(['\"]?(api[_-]?key|secret|token)[\"']?\s*[:=]\s*['\"])([^'\"]+)(['\"])/gi;
        if (regex.test(content)) {
          content = content.replace(regex, (_, start, type, val, end) => {
            detectedKeys.push(`${type}:${val}`);
            return `${start}***${end}`;
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

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      keys: detectedKeys,
      downloadUrl: null
    })
  };
};
