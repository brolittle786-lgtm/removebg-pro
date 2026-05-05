/**
 * routes/removebg.js
 * Reads the uploaded original file, sends it to remove.bg API,
 * saves the result, deducts 1 credit, and returns the processed image URL.
 */

const router = require("express").Router();
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const authMiddleware = require("../middleware/auth");
const { findUserById, updateUser } = require("../utils/userStore");

// ─── POST /api/remove-bg ──────────────────────────────────────────────────────
router.post("/", authMiddleware, async (req, res) => {
  const { filename } = req.body;

  if (!filename) {
    return res.status(400).json({ error: "No filename provided." });
  }

  // Basic safety: disallow path traversal
  const safeFilename = path.basename(filename);
  const originalPath = path.join(__dirname, "..", "uploads", safeFilename);

  if (!fs.existsSync(originalPath)) {
    return res.status(404).json({ error: "Original image not found. Please re-upload." });
  }

  // ─── Check credits ──────────────────────────────────────────────────────
  const user = findUserById(req.user.id);
  if (!user) return res.status(401).json({ error: "User not found." });

  // if (user.credits <= 0) {
  //   return res.status(402).json({
  //     error: "You have no credits remaining. Please upgrade your plan.",
  //     credits: 0,
  //   });
  // }

  // ─── Call remove.bg API ─────────────────────────────────────────────────
  try {
    const formData = new FormData();
    formData.append("image_file", fs.createReadStream(originalPath));
    formData.append("size", "full");

    const apiKey = process.env.REMOVE_BG_API_KEY;
    if (!apiKey || apiKey === "your_remove_bg_api_key_here") {
      // Demo mode: return a placeholder when no API key is set
      return res.status(503).json({
        error:
          "Remove.bg API key is not configured. Set REMOVE_BG_API_KEY in your .env file.",
      });
    }

    const response = await axios.post(
      "https://api.remove.bg/v1.0/removebg",
      formData,
      {
        headers: {
          "X-Api-Key": apiKey,
          ...formData.getHeaders(),
        },
        responseType: "arraybuffer",
        timeout: 60000, // 60 second timeout
      }
    );

    // ─── Save result image ────────────────────────────────────────────────
    const resultFilename = `result_${uuidv4()}.png`;
    const resultPath = path.join(__dirname, "..", "uploads", resultFilename);
    fs.writeFileSync(resultPath, response.data);

    // ─── Deduct 1 credit ──────────────────────────────────────────────────
    const updatedUser = updateUser(user.id, { credits: user.credits - 1 });

    const resultUrl = `${req.protocol}://${req.get("host")}/uploads/${resultFilename}`;

    res.json({
      message: "Background removed successfully!",
      resultUrl,
      resultFilename,
      credits: updatedUser.credits,
    });
  } catch (err) {
    // ─── Handle remove.bg API errors ──────────────────────────────────────
    if (err.response) {
      const status = err.response.status;
      let errorMsg = "Failed to remove background.";

      if (status === 402) {
        errorMsg = "Remove.bg API credit limit reached. Please check your remove.bg account.";
      } else if (status === 400) {
        errorMsg = "Invalid image. Please upload a clear photo with a visible subject.";
      } else if (status === 403) {
        errorMsg = "Remove.bg API key is invalid. Please check your API key.";
      } else if (status === 429) {
        errorMsg = "Too many requests to the API. Please wait a moment and try again.";
      }

      // Try to parse error from arraybuffer response
      try {
        const errText = Buffer.from(err.response.data).toString("utf-8");
        const errJson = JSON.parse(errText);
        if (errJson?.errors?.[0]?.title) {
          errorMsg = errJson.errors[0].title;
        }
      } catch {}

      return res.status(status >= 500 ? 502 : status).json({ error: errorMsg });
    }

    if (err.code === "ECONNABORTED") {
      return res.status(504).json({ error: "Request timed out. Please try again." });
    }

    console.error("remove-bg error:", err.message);
    res.status(500).json({ error: "Server error while processing image." });
  }
});

// ─── DELETE /api/remove-bg/cleanup ───────────────────────────────────────────
// Optionally clean up uploaded files (call after user downloads result)
router.delete("/cleanup", authMiddleware, (req, res) => {
  const { filenames } = req.body; // array of filenames to delete
  if (!Array.isArray(filenames)) {
    return res.status(400).json({ error: "filenames must be an array." });
  }

  filenames.forEach((name) => {
    const safe = path.basename(name);
    const filePath = path.join(__dirname, "..", "uploads", safe);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
  });

  res.json({ message: "Files cleaned up." });
});

// Download endpoint - forces file download
router.get("/download/:filename", authMiddleware, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(__dirname, "..", "uploads", filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found." });
  }
  
  res.setHeader("Content-Disposition", `attachment; filename="removebg-result.png"`);
  res.setHeader("Content-Type", "image/png");
  res.sendFile(filePath);
});

module.exports = router;
