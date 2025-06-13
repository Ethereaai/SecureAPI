const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const os = require("os");

exports.handler = async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-"));
  const entryFile = path.join(tmpDir, "index.js");

  const content = `
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Hello from your generated API!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`API running on port \${PORT}\`);
});
  `.trim();

  fs.writeFileSync(entryFile, content);

  const zipPath = path.join(os.tmpdir(), `api_boilerplate_${Date.now()}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.pipe(output);
  archive.directory(tmpDir, false);
  archive.finalize();

  await new Promise(resolve => output.on("close", resolve));

  const buffer = fs.readFileSync(zipPath);
  const base64 = buffer.toString("base64");

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      link: `data:application/zip;base64,${base64}`,
    }),
  };
};
