import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";

test("an upload aborted before disk filename assignment leaves no orphan and a later upload succeeds", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-upload-abort-"));
  const filenameReached = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const storageFinished = Promise.withResolvers();
  let releaseFilename;
  let first = true;
  const storage = multer.diskStorage({
    destination: root,
    filename(req, _file, callback) {
      if (!first) return callback(null, "retry.tmp");
      first = false;
      req.once("aborted", aborted.resolve);
      releaseFilename = () => callback(null, "aborted.tmp");
      filenameReached.resolve();
    },
  });
  const handleFile = storage._handleFile.bind(storage);
  storage._handleFile = (req, file, callback) => {
    handleFile(req, file, (...args) => {
      callback(...args);
      storageFinished.resolve();
    });
  };
  const app = express();
  app.post("/upload", multer({ storage }).single("file"), async (req, res) => {
    const bytes = await fs.readFile(req.file.path, "utf8");
    await fs.rm(req.file.path);
    res.json({ bytes });
  });
  app.use((_cause, _req, res, _next) => res.status(400).end());
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const request = http.request(`${origin}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=abort-fixture",
      "Content-Length": "1048576",
    },
  });
  request.on("error", () => {});
  t.after(async () => {
    request.destroy();
    releaseFilename?.();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-upload-abort-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  request.write(
    '--abort-fixture\r\nContent-Disposition: form-data; name="file"; filename="world.dat"\r\nContent-Type: application/octet-stream\r\n\r\noriginal bytes\r\n--abort-fixture--\r\n',
  );
  await filenameReached.promise;
  request.destroy();
  await aborted.promise;
  releaseFilename();
  releaseFilename = null;
  await storageFinished.promise;
  // Late storage callbacks can finish after the middleware's error handler.
  // Wait for their cleanup, then also exercise the same route again.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await fs.readdir(root)).length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(await fs.readdir(root), []);
  const form = new FormData();
  form.append("file", new Blob(["successful retry bytes"]), "world.dat");
  const response = await fetch(`${origin}/upload`, {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { bytes: "successful retry bytes" });
  assert.deepEqual(await fs.readdir(root), []);
});
