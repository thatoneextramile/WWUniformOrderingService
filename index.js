/**
 * WONDERWORLD UNIFORMS — EXPRESS.JS BACKEND API
 * ============================================================
 * Install dependencies:
 *   npm install express cors bcryptjs jsonwebtoken
 *               @prisma/client multer sharp
 *               express-async-errors dotenv
 *
 * For S3 storage (production), also install:
 *   npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 *
 * Environment variables (.env):
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/wonderworld
 *   JWT_SECRET=your-secret-key-min-32-chars
 *   JWT_EXPIRES_IN=7d
 *   PORT=4000
 *
 *   # Storage mode: "local" (default) or "s3"
 *   STORAGE_MODE=local
 *   UPLOAD_DIR=uploads            # local only
 *   PUBLIC_URL=http://localhost:4000  # base URL prepended to local file paths
 *
 *   # S3 / R2 (only needed when STORAGE_MODE=s3)
 *   AWS_REGION=ca-central-1
 *   AWS_BUCKET=wonderworld-uploads
 *   AWS_ACCESS_KEY_ID=...
 *   AWS_SECRET_ACCESS_KEY=...
 *   # For Cloudflare R2, also set:
 *   AWS_ENDPOINT=https://<account>.r2.cloudflarestorage.com
 *
 * ============================================================
 * PRISMA SCHEMA CHANGES NEEDED
 * ============================================================
 * Add imageUrls to the Product model:
 *
 *   model Product {
 *     ...
 *     imageUrl   String?           // legacy single image (kept for compat)
 *     imageUrls  String[]          // NEW: ordered array of image URLs
 *     imageEmoji String?  @default("👕")
 *     ...
 *   }
 *
 * Then run:
 *   npx prisma migrate dev --name add_product_image_urls
 * ============================================================
 */

import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import "express-async-errors";
import dotenv from "dotenv";
dotenv.config();
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const STORAGE_MODE = process.env.STORAGE_MODE || "local";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const PUBLIC_URL = (
  process.env.PUBLIC_URL || `http://localhost:${PORT}`
).replace(/\/$/, "");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// ─── ENSURE LOCAL UPLOAD DIR EXISTS ──────────────────────────
if (STORAGE_MODE === "local" && !fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

async function getAdminEmailList() {
  const s = await prisma.siteSettings.findUnique({
    where: { id: "singleton" },
    select: { adminEmails: true },
  });
  const emails = (s?.adminEmails || "")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  console.log(emails);
  if (emails.length > 0) return emails;
  return process.env.ADMIN_EMAIL ? [process.env.ADMIN_EMAIL] : [];
}

// ─── MULTER CONFIG ────────────────────────────────────────────
// Accepts up to 10 images per request, max 8 MB each.
// Validates mime type before saving — rejects non-images immediately.
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB

const multerStorage = multer.memoryStorage();

const multerFilter = (req, file, cb) => {
  if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
  else cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
};

const upload = multer({
  storage: multerStorage,
  fileFilter: multerFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

// Serve local uploads as static files
app.use("/uploads", express.static(UPLOAD_DIR));

// ─── S3 STORAGE HELPER (only loaded when STORAGE_MODE=s3) ────
// Lazy-loaded so local mode doesn't require the AWS SDK installed.
let s3Upload = null;
async function getS3Uploader() {
  if (s3Upload) return s3Upload;
  const { S3Client, PutObjectCommand, DeleteObjectCommand } =
    await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT, // for R2 / custom endpoints
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  s3Upload = { s3, PutObjectCommand, DeleteObjectCommand };
  return s3Upload;
}

/**
 * uploadFile(localPath, filename, mimetype) → public URL string
 *
 * In local mode: just returns the public URL for the already-saved file.
 * In s3 mode: reads the file, uploads to S3, deletes the temp file,
 *             returns the S3 public URL.
 */
async function uploadFile(buffer, filename, mimetype) {
  console.log(STORAGE_MODE);
  if (STORAGE_MODE === "supabase") {
    const { error } = await supabase.storage
      .from("products")
      .upload(`images/${filename}`, buffer, {
        contentType: mimetype,
        upsert: true,
      });
    if (error) throw new Error(`Supabase upload failed: ${error.message}`);
    const { data } = supabase.storage
      .from("products")
      .getPublicUrl(`images/${filename}`);
    return data.publicUrl;
  }
  // local fallback — write buffer to disk
  const localPath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(localPath, buffer);
  return `${PUBLIC_URL}/uploads/${filename}`;
}

/**
 * deleteFile(url) — best-effort cleanup when images are removed.
 * Extracts filename from URL and deletes from disk (local) or S3.
 */
async function deleteFile(url) {
  try {
    if (!url) return;
    if (STORAGE_MODE === "supabase") {
      const marker = "/storage/v1/object/public/products/";
      const filePath = url.split(marker)[1];
      if (filePath) await supabase.storage.from("products").remove([filePath]);
      return;
    }
    // local fallback
    const filename = url.split("/uploads/")[1];
    if (filename) {
      const localPath = path.join(UPLOAD_DIR, filename);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
  } catch (err) {
    console.warn("deleteFile warning:", err.message);
  }
}

async function sendOrderEmails(order, parentEmail) {
  if (!process.env.RESEND_API_KEY) return; // skip if not configured

  const itemsHtml = order.items
    .map(
      (i) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${i.productName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${i.size}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${i.quantity}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">$${Number(i.unitPrice).toFixed(2)}</td>
      </tr>`,
    )
    .join("");

  const orderSummaryHtml = `
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <thead>
        <tr style="background:#f7f8fa">
          <th style="padding:8px 12px;text-align:left">Item</th>
          <th style="padding:8px 12px;text-align:center">Size</th>
          <th style="padding:8px 12px;text-align:center">Qty</th>
          <th style="padding:8px 12px;text-align:right">Price</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>
    <table style="width:100%;margin-top:8px">
      <tr><td style="padding:4px 12px;color:#666">Subtotal</td><td style="padding:4px 12px;text-align:right">$${Number(order.subtotal).toFixed(2)}</td></tr>
      ${Number(order.discountAmount) > 0 ? `<tr><td style="padding:4px 12px;color:#e05a2b">Discount</td><td style="padding:4px 12px;text-align:right;color:#e05a2b">-$${Number(order.discountAmount).toFixed(2)}</td></tr>` : ""}
      <tr style="font-weight:700;font-size:16px"><td style="padding:8px 12px;border-top:2px solid #eee">Total</td><td style="padding:8px 12px;text-align:right;border-top:2px solid #eee;color:#1a7a55">$${Number(order.totalAmount).toFixed(2)}</td></tr>
    </table>`;

  const baseStyle = `font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1d23`;

  const footerHtml = `
  <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e0e0e0;font-family:Arial,sans-serif;font-size:13px;color:#333;line-height:1.7">

    <!-- Signature block -->
    <p style="margin:0">Warm regards,</p>
    <div style="font-weight:800;color:#86BAAF">
    <p style="margin:4px 0 0 0">Jinny</p>
    <p style="margin:0">Admin team</p>
    <p style="margin:0">WONDERWORLD MONTESSORI ACADEMY</p>
    <p style="margin:0">AMI Recognized School</p>
    </div>

    <!-- Contact row -->
    <p style="margin:10px 0 4px 0">
      <strong>P:</strong> <a href="tel:6045719844" style="color:#333;text-decoration:none">(604) 571-9844</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <strong>W:</strong> <a href="https://wonderworldmontessori.ca" style="color:#1a5c8a;text-decoration:none">wonderworldmontessori.ca</a>
    </p>
    <p style="margin:0 0 4px 0">
      <strong>E:</strong> <a href="mailto:info@wonderworldmontessori.ca" style="color:#1a5c8a;text-decoration:none">info@wonderworldmontessori.ca</a>
    </p>
    <p style="margin:0 0 16px 0">
      <strong>A:</strong> 6390 Silver Avenue, Burnaby, BC, Canada
    </p>

    <!-- Logo images row -->
    <div style="margin-bottom:12px">
      <img
        src="https://gibwhnncxuosgilhkuhl.supabase.co/storage/v1/object/public/products/images/footer_image_ww.png"
        alt="Wonderworld Montessori Academy"
        style="height:70px;margin-right:12px;vertical-align:bottom"
        onerror="this.style.display='none'"
      />
    </div>

    <!-- Quote -->
    <p style="margin:0;font-style:italic;font-size:12px;color:#444;font-weight:900">
      &ldquo;The goal of early childhood education should be to activate the child&rsquo;s own natural desire to learn.&rdquo; - Maria Montessori
    </p>
  </div>`;

  // ── Email to parent ──────────────────────────────────────
  const parentHtml = `
    <div style="${baseStyle}">
      <div style="background:#1a7a55;padding:24px 32px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px">🎒 Order Confirmed!</h1>
      </div>
      <div style="background:#fff;padding:32px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
        <p>Hi <strong>${order.parentName}</strong>,</p>
        <p>Your uniform order has been received and is being reviewed. We'll update you when it's ready for pick up.</p>
        <div style="background:#f7f8fa;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:0 0 4px 0;font-size:13px;color:#666">Order Number</p>
          <p style="margin:0;font-size:20px;font-weight:700;color:#1a7a55">${order.orderNumber}</p>
        </div>
        <p><strong>Child:</strong> ${order.childName} · ${order.childClass}</p>
        ${orderSummaryHtml}
        <p style="color:#666;font-size:13px;margin-top:24px">You'll receive another email when your order is ready for pick up.</p>
         ${footerHtml}
      </div>
    </div>`;

  // ── Email to admin ───────────────────────────────────────
  const adminHtml = `
    <div style="${baseStyle}">
      <div style="background:#1a5f8a;padding:24px 32px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px">📋 New Order Received</h1>
      </div>
      <div style="background:#fff;padding:32px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
        <div style="background:#f7f8fa;border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="margin:0 0 4px 0;font-size:13px;color:#666">Order Number</p>
          <p style="margin:0;font-size:20px;font-weight:700;color:#1a5f8a">${order.orderNumber}</p>
        </div>
        <p><strong>Parent:</strong> ${order.parentName} · ${order.parentPhone}</p>
        <p><strong>Child:</strong> ${order.childName} · ${order.childClass}</p>
        ${orderSummaryHtml}
         ${footerHtml}
      </div>
    </div>`;

  // Send both emails concurrently, don't let email failure break the order
  const adminEmailList = await getAdminEmailList();
  // Send parent confirmation + one email per admin concurrently
  await Promise.allSettled([
    resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: parentEmail,
      subject: `Order Confirmed — ${order.orderNumber}`,
      html: parentHtml,
    }),
    ...adminEmailList.map((email) =>
      resend.emails.send({
        from: process.env.EMAIL_FROM,
        to: email,
        subject: `New Order — ${order.orderNumber} from ${order.parentName}`,
        html: adminHtml,
      }),
    ),
  ]);
}

// ─── CORS ─────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:5173",
  "https://wonder-world-uniform.vercel.app",
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || origin.includes(".vercel.app"))
        return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" })); // allow slightly larger JSON bodies

// ─── AUTH HELPERS ─────────────────────────────────────────────

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function adminMiddleware(roles = []) {
  return [
    authMiddleware,
    (req, res, next) => {
      if (req.user.type !== "admin")
        return res.status(403).json({ error: "Admin access required" });
      if (roles.length && !roles.includes(req.user.role))
        return res.status(403).json({ error: "Insufficient permissions" });
      next();
    },
  ];
}

function parentMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.type !== "parent")
      return res.status(403).json({ error: "Parent access required" });
    next();
  });
}

// ─── PRODUCT RESPONSE HELPER ──────────────────────────────────
// Normalises a product from the DB into the shape the frontend expects.
// Always returns an `images` array (merging imageUrls + legacy imageUrl)
// and a `sizes` array derived from inventory rows.
function formatProduct(p, { includeAdminFields = false } = {}) {
  const images = p.imageUrls?.length
    ? p.imageUrls
    : p.imageUrl
      ? [p.imageUrl]
      : [];

  const base = {
    id: p.id,
    name: p.name,
    description: p.description,
    imageEmoji: p.imageEmoji || "👕",
    imageBg: p.imageBg || "#e8f7f0",
    category: p.category,
    sellingPrice: parseFloat(p.sellingPrice),
    sortOrder: p.sortOrder,
    isActive: p.isActive,
    images,
    sizes: p.inventory ? p.inventory.map((i) => i.size) : [],
  };

  if (includeAdminFields) {
    base.costPrice = parseFloat(p.costPrice);
    base.inventory = p.inventory;
  }

  return base;
}

// ─── ORDER NUMBER GENERATOR ───────────────────────────────────
async function generateOrderNumber(locationId) {
  let prefix = "W";
  if (locationId) {
    const loc = await prisma.location.findUnique({
      where: { id: locationId },
      select: { name: true },
    });
    if (loc?.name) {
      // Take the part before the first dash, split into words,
      // use the first letter of each word
      // e.g. "William West-Burnaby North" → "WW"
      // e.g. "Buchana-Burnaby North"      → "B"
      const beforeDash = loc.name.split("-")[0].trim();
      prefix = beforeDash
        .split(/\s+/)
        .map((word) => word[0].toUpperCase())
        .join("");
    }
  }

  // Find last order with the same prefix to keep numbering per-location
  const last = await prisma.order.findFirst({
    where: { orderNumber: { startsWith: `${prefix}-` } },
    orderBy: { createdAt: "desc" },
    select: { orderNumber: true },
  });
  const num = last
    ? parseInt(last.orderNumber.replace(`${prefix}-`, "")) + 1
    : 1001;
  return `${prefix}-${String(num).padStart(4, "0")}`;
}

// ─── INVENTORY TRANSITION LOGIC ───────────────────────────────
async function applyInventoryTransition(orderId, fromStatus, toStatus, tx) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) return;

  const SOLD_STATUSES = ["PAID", "READY_FOR_PICKUP", "PICKED_UP"];
  const PENDING_STATUSES = ["SUBMITTED", "REVIEW"];

  for (const item of order.items) {
    const inv = await tx.inventory.findUnique({
      where: { productId_size: { productId: item.productId, size: item.size } },
    });
    if (!inv) continue;

    let update = {};

    // ── Entering SUBMITTED / REVIEW → reserve stock ──────────
    if (
      PENDING_STATUSES.includes(toStatus) &&
      !PENDING_STATUSES.includes(fromStatus)
    ) {
      update = { reservedQty: { increment: item.quantity } };
    }

    // ── Entering PAID, READY_FOR_PICKUP, or PICKED_UP ────────
    // From pending → deduct total, release reserved, increment sold
    if (
      SOLD_STATUSES.includes(toStatus) &&
      PENDING_STATUSES.includes(fromStatus)
    ) {
      update = {
        totalQty: { decrement: item.quantity },
        reservedQty: { decrement: item.quantity },
        soldQty: { increment: item.quantity },
      };
    }

    // From one sold status to another sold status → only update sold qty difference
    // (stock already deducted, just track the sold count accurately)
    if (
      SOLD_STATUSES.includes(toStatus) &&
      SOLD_STATUSES.includes(fromStatus)
    ) {
      // No stock movement needed — already deducted when first entering a SOLD status
      update = {};
    }

    // ── CANCELLED ────────────────────────────────────────────
    if (toStatus === "CANCELLED") {
      if (PENDING_STATUSES.includes(fromStatus)) {
        // Was reserved but not sold → release reservation
        update = { reservedQty: { decrement: item.quantity } };
      } else if (SOLD_STATUSES.includes(fromStatus)) {
        // Was sold → restore total stock and reduce sold count
        update = {
          totalQty: { increment: item.quantity },
          soldQty: { decrement: item.quantity },
        };
      }
    }

    if (Object.keys(update).length) {
      await tx.inventory.update({ where: { id: inv.id }, data: update });
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  IMAGE UPLOAD ROUTES
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/admin/products/:id/images
 * Upload 1–10 photos for a product.
 * Appends to existing imageUrls — does not replace them.
 *
 * Request: multipart/form-data
 *   images[]  File  (1–10 files, jpg/png/webp/gif, max 8 MB each)
 *
 * Response: { id, images: string[] }  — full updated image list
 */
app.post(
  "/api/admin/products/:id/images",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  upload.array("images", 10),
  async (req, res) => {
    if (!req.files?.length)
      return res.status(400).json({
        error: "No images uploaded. Send files under the field name 'images'",
      });
    console.log("start uploading");
    // Upload each file and collect URLs
    const newUrls = await Promise.all(
      req.files.map((f) => {
        const ext = path.extname(f.originalname).toLowerCase() || ".jpg";
        const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
        return uploadFile(f.buffer, filename, f.mimetype);
      }),
    );

    // Fetch current imageUrls and append
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { id: true, imageUrls: true, imageUrl: true },
    });
    if (!product) {
      // Clean up uploaded files before erroring
      await Promise.all(newUrls.map(deleteFile));
      return res.status(404).json({ error: "Product not found" });
    }

    const existing = product.imageUrls?.length
      ? product.imageUrls
      : product.imageUrl
        ? [product.imageUrl]
        : [];

    const merged = [...existing, ...newUrls];

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: { imageUrls: merged, imageUrl: merged[0] ?? null },
      select: { id: true, imageUrls: true },
    });

    res.json({ id: updated.id, images: updated.imageUrls });
  },
);

/**
 * PUT /api/admin/products/:id/images
 * Replace the full image list (reorder, delete, or set from scratch).
 * Deletes any URLs that were previously stored but are absent from the new list.
 *
 * Request: application/json
 *   { images: string[] }  — ordered array of URLs to keep
 *
 * Response: { id, images: string[] }
 */
app.put(
  "/api/admin/products/:id/images",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const { images } = req.body;
    if (!Array.isArray(images))
      return res
        .status(400)
        .json({ error: "images must be an array of URL strings" });

    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { id: true, imageUrls: true, imageUrl: true },
    });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const previous = product.imageUrls?.length
      ? product.imageUrls
      : product.imageUrl
        ? [product.imageUrl]
        : [];

    // Delete files that were removed from the list
    const removed = previous.filter((url) => !images.includes(url));
    await Promise.all(removed.map(deleteFile));

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: { imageUrls: images, imageUrl: images[0] ?? null },
      select: { id: true, imageUrls: true },
    });

    res.json({ id: updated.id, images: updated.imageUrls });
  },
);

/**
 * DELETE /api/admin/products/:id/images/:imageIndex
 * Remove a single image by its position in the array (0-based index).
 * Deletes the file from disk/S3 and shifts remaining images down.
 *
 * Response: { id, images: string[] }
 */
app.delete(
  "/api/admin/products/:id/images/:imageIndex",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const idx = parseInt(req.params.imageIndex);
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { id: true, imageUrls: true, imageUrl: true },
    });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const current = product.imageUrls?.length
      ? [...product.imageUrls]
      : product.imageUrl
        ? [product.imageUrl]
        : [];

    if (idx < 0 || idx >= current.length)
      return res.status(400).json({
        error: `Image index ${idx} out of range (0–${current.length - 1})`,
      });

    const [removed] = current.splice(idx, 1);
    await deleteFile(removed);

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: { imageUrls: current, imageUrl: current[0] ?? null },
      select: { id: true, imageUrls: true },
    });

    res.json({ id: updated.id, images: updated.imageUrls });
  },
);

// ══════════════════════════════════════════════════════════════
//  SEEDING
// ══════════════════════════════════════════════════════════════

app.post(
  "/api/admin/seed",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    await prisma.siteSettings.upsert({
      where: { id: "singleton" },
      update: {},
      create: {
        id: "singleton",
        systemName: "Wonderworld Uniforms",
        welcomeTitle: "Welcome to Wonderworld! 🌈",
        discountThreshold: 500,
        discountRate: 0.15,
      },
    });
    const fields = [
      {
        label: "Child's Name",
        fieldKey: "childName",
        isRequired: true,
        isSystem: true,
        sortOrder: 1,
      },
      {
        label: "Class",
        fieldKey: "childClass",
        isRequired: true,
        isSystem: true,
        sortOrder: 2,
      },
      {
        label: "Parent Name",
        fieldKey: "parentName",
        isRequired: true,
        isSystem: true,
        sortOrder: 3,
      },
      {
        label: "Phone Number",
        fieldKey: "parentPhone",
        fieldType: "phone",
        isRequired: true,
        isSystem: true,
        sortOrder: 4,
      },
      {
        label: "School Location",
        fieldKey: "locationId",
        fieldType: "select",
        isRequired: true,
        isSystem: true,
        sortOrder: 5,
      },
      {
        label: "Notes",
        fieldKey: "notes",
        fieldType: "textarea",
        isRequired: false,
        isSystem: false,
        sortOrder: 6,
      },
    ];
    for (const f of fields)
      await prisma.formField.upsert({
        where: { fieldKey: f.fieldKey },
        update: {},
        create: f,
      });
    res.json({ ok: true, message: "Seeded successfully" });
  },
);

// ══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════

app.post("/api/auth/parent/register", async (req, res) => {
  const { firstName, lastName, email, phone, password } = req.body;
  if (!firstName || !email || !password)
    return res
      .status(400)
      .json({ error: "firstName, email, password required" });
  const exists = await prisma.parent.findUnique({ where: { email } });
  if (exists)
    return res.status(409).json({ error: "Email already registered" });
  const hashed = await bcrypt.hash(password, 12);
  const parent = await prisma.parent.create({
    data: { firstName, lastName, email, phone, password: hashed },
  });
  const token = signToken({ id: parent.id, type: "parent" });
  res.status(201).json({
    token,
    parent: { id: parent.id, firstName, lastName, email, phone },
  });
});

app.post("/api/auth/parent/login", async (req, res) => {
  const { email, password } = req.body;
  const parent = await prisma.parent.findUnique({ where: { email } });
  if (
    !parent ||
    !parent.isActive ||
    !(await bcrypt.compare(password, parent.password))
  )
    return res.status(401).json({ error: "Invalid credentials" });
  const token = signToken({ id: parent.id, type: "parent" });
  res.json({
    token,
    parent: {
      id: parent.id,
      firstName: parent.firstName,
      lastName: parent.lastName,
      email: parent.email,
      phone: parent.phone,
    },
  });
});

app.post("/api/auth/admin/login", async (req, res) => {
  const { email, password } = req.body;
  const admin = await prisma.admin.findUnique({ where: { email } });
  if (
    !admin ||
    !admin.isActive ||
    !(await bcrypt.compare(password, admin.password))
  )
    return res.status(401).json({ error: "Invalid credentials" });
  const token = signToken({ id: admin.id, type: "admin", role: admin.role });
  res.json({
    token,
    admin: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    },
  });
});

// ══════════════════════════════════════════════════════════════
//  PUBLIC / PARENT ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/products — active products, no costPrice, with images array
app.get("/api/products", async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      description: true,
      imageUrl: true,
      imageUrls: true,
      imageEmoji: true,
      imageBg: true,
      category: true,
      sellingPrice: true,
      sortOrder: true,
      isActive: true,
      inventory: { select: { size: true } },
    },
    orderBy: { sortOrder: "asc" },
  });
  res.json(products.map((p) => formatProduct(p)));
});

app.get("/api/locations", async (req, res) => {
  res.json(
    await prisma.location.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    }),
  );
});

app.get("/api/settings", async (req, res) => {
  const s = await prisma.siteSettings.findUnique({
    where: { id: "singleton" },
  });
  res.json({
    systemName: s?.systemName,
    logoUrl: s?.logoUrl,
    logoEmoji: s?.logoEmoji,
    welcomeTitle: s?.welcomeTitle,
    welcomeText: s?.welcomeText,
    orderInstructions: s?.orderInstructions,
    noticeText: s?.noticeText,
    discountThreshold: s?.discountThreshold,
    discountRate: s?.discountRate,
    adminEmails: s?.adminEmails,
    orderStockThreshold: s?.orderStockThreshold ?? 0,
  });
});

app.get("/api/form-fields", async (req, res) => {
  res.json(
    await prisma.formField.findMany({
      where: { isVisible: true },
      orderBy: { sortOrder: "asc" },
    }),
  );
});

// ─── ORDERS (PARENT) ─────────────────────────────────────────

app.post("/api/orders", parentMiddleware, async (req, res) => {
  const {
    childName,
    childClass,
    parentName,
    parentPhone,
    locationId,
    notes,
    extraFields,
    items,
  } = req.body;
  if (!items?.length)
    return res.status(400).json({ error: "Order must have at least one item" });

  const settings = await prisma.siteSettings.findUnique({
    where: { id: "singleton" },
  });
  const orderStockThreshold = settings?.orderStockThreshold ?? 0;
  if (orderStockThreshold > 0) {
    // Check every item against the threshold
    for (const item of items) {
      const inv = await prisma.inventory.findUnique({
        where: {
          productId_size: { productId: item.productId, size: item.size },
        },
      });
      const available = inv ? inv.totalQty - inv.reservedQty : 0;
      if (available <= orderStockThreshold) {
        return res.status(400).json({
          error: `Sorry, ${item.productName} (${item.size}) is currently unavailable for ordering.`,
        });
      }
    }
  }

  const threshold = parseFloat(settings?.discountThreshold || 500);
  const discountRate = parseFloat(settings?.discountRate || 0.15);
  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

  // Check if this child has had a previous non-cancelled order
  const previousOrderCount = await prisma.order.count({
    where: {
      parentId: req.user.id,
      childName: { equals: childName, mode: "insensitive" },
      status: { notIn: ["CANCELLED"] },
    },
  });
  const isFirstOrder = previousOrderCount === 0;
  const appliedRate = subtotal >= threshold && isFirstOrder ? discountRate : 0;

  const discountAmount = +(subtotal * appliedRate).toFixed(2);
  const totalAmount = +(subtotal - discountAmount).toFixed(2);
  const orderNumber = await generateOrderNumber(locationId);
  const parent = await prisma.parent.findUnique({ where: { id: req.user.id } });

  const order = await prisma.$transaction(async (tx) => {
    // for (const item of items) {
    //   const inv = await tx.inventory.findUnique({
    //     where: {
    //       productId_size: { productId: item.productId, size: item.size },
    //     },
    //   });
    //   const available = inv ? inv.totalQty - inv.reservedQty : 0;
    //   if (available < item.quantity)
    //     throw new Error(
    //       `Insufficient stock: ${item.productName} size ${item.size} (available: ${available})`,
    //     );
    // }
    // Inventory check removed — orders are allowed even with insufficient stock.
    // Admin can manage stock discrepancies manually via the Inventory page.
    const newOrder = await tx.order.create({
      data: {
        orderNumber,
        parentId: req.user.id,
        parentName: parentName || `${parent.firstName} ${parent.lastName}`,
        parentPhone: parentPhone || parent.phone,
        childName,
        childClass,
        locationId,
        notes,
        extraFields,
        subtotal,
        discountRate: appliedRate,
        discountAmount,
        totalAmount,
        status: "SUBMITTED",
        statusHistory: [
          {
            status: "SUBMITTED",
            changedAt: new Date().toISOString(),
            changedBy: req.user.id,
          },
        ],
        items: {
          create: items.map((i) => ({
            productId: i.productId,
            productName: i.productName,
            size: i.size,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
          })),
        },
      },
      include: { items: true, location: true },
    });
    for (const item of newOrder.items) {
      await tx.inventory.update({
        where: {
          productId_size: { productId: item.productId, size: item.size },
        },
        data: { reservedQty: { increment: item.quantity } },
      });
    }
    return newOrder;
  });
  // Send confirmation emails (non-blocking — won't fail the order if email fails)
  sendOrderEmails(order, parent.email).catch((err) =>
    console.warn("Email send failed:", err.message),
  );
  res.status(201).json(order);
});

app.get("/api/orders/check-first-order", parentMiddleware, async (req, res) => {
  const { childName } = req.query;
  if (!childName) return res.json({ isFirstOrder: true });
  const count = await prisma.order.count({
    where: {
      parentId: req.user.id,
      childName: { equals: childName.trim(), mode: "insensitive" },
      status: { notIn: ["CANCELLED"] },
    },
  });
  res.json({ isFirstOrder: count === 0 });
});

app.get("/api/orders/mine", parentMiddleware, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { parentId: req.user.id },
    include: { items: true, location: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});

// ══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════

// ─── PRODUCTS ────────────────────────────────────────────────

// GET /api/admin/products — full product list including costPrice and images
app.get("/api/admin/products", adminMiddleware(), async (req, res) => {
  const products = await prisma.product.findMany({
    include: { inventory: true },
    orderBy: { sortOrder: "asc" },
  });
  res.json(products.map((p) => formatProduct(p, { includeAdminFields: true })));
});

/**
 * POST /api/admin/products
 * Create a new product. Images are NOT accepted here — create the product
 * first, then upload images via POST /api/admin/products/:id/images.
 * This keeps the creation route simple (JSON only, no multipart).
 */
app.post(
  "/api/admin/products",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const {
      name,
      description,
      imageEmoji,
      imageBg,
      category,
      sellingPrice,
      costPrice,
      sizes,
      isActive,
      sortOrder,
    } = req.body;
    if (!name || !sellingPrice || !costPrice)
      return res
        .status(400)
        .json({ error: "name, sellingPrice, costPrice required" });

    const product = await prisma.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: {
          name,
          description,
          imageEmoji,
          imageBg,
          imageUrls: [], // start empty; use the /images endpoint to upload
          category,
          sellingPrice: +sellingPrice,
          costPrice: +costPrice,
          isActive: isActive ?? true,
          sortOrder: sortOrder ?? 0,
        },
      });
      if (sizes?.length)
        await tx.inventory.createMany({
          data: sizes.map((s) => ({
            productId: p.id,
            size: s,
            totalQty: 0,
            reservedQty: 0,
          })),
        });
      return tx.product.findUnique({
        where: { id: p.id },
        include: { inventory: true },
      });
    });
    res.status(201).json(formatProduct(product, { includeAdminFields: true }));
  },
);

/**
 * PUT /api/admin/products/:id
 * Update product metadata (name, prices, category, emoji, active flag).
 * Does NOT touch images — use the /images sub-routes for that.
 */
app.put(
  "/api/admin/products/:id",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const {
      name,
      description,
      imageEmoji,
      imageBg,
      category,
      sellingPrice,
      costPrice,
      isActive,
      sortOrder,
    } = req.body;
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        name,
        description,
        imageEmoji,
        imageBg,
        category,
        sellingPrice: sellingPrice ? +sellingPrice : undefined,
        costPrice: costPrice ? +costPrice : undefined,
        isActive,
        sortOrder,
      },
      include: { inventory: true },
    });
    res.json(formatProduct(product, { includeAdminFields: true }));
  },
);

/**
 * DELETE /api/admin/products/:id
 * Deletes the product AND all its associated image files from disk/S3.
 */
app.delete(
  "/api/admin/products/:id",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { imageUrls: true, imageUrl: true },
    });
    if (product) {
      const urls = product.imageUrls?.length
        ? product.imageUrls
        : product.imageUrl
          ? [product.imageUrl]
          : [];
      await Promise.all(urls.map(deleteFile));
    }
    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  },
);

// ─── INVENTORY ───────────────────────────────────────────────

app.get("/api/admin/inventory", adminMiddleware(), async (req, res) => {
  const inv = await prisma.inventory.findMany({
    include: {
      product: {
        select: {
          name: true,
          isActive: true,
          imageUrls: true,
          imageUrl: true,
          imageEmoji: true,
        },
      },
    },
    orderBy: [{ product: { name: "asc" } }, { size: "asc" }],
  });
  res.json(
    inv.map((i) => ({ ...i, availableQty: i.totalQty - i.reservedQty })),
  );
});

app.put(
  "/api/admin/inventory/:id",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const { totalQty } = req.body;
    const inv = await prisma.inventory.findUnique({
      where: { id: req.params.id },
    });
    if (!inv) return res.status(404).json({ error: "Not found" });
    // if (+totalQty < inv.reservedQty)
    //   return res.status(400).json({
    //     error: `Cannot set total below reserved (${inv.reservedQty})`,
    //   });
    const updated = await prisma.inventory.update({
      where: { id: req.params.id },
      data: { totalQty: +totalQty },
    });
    res.json({
      ...updated,
      availableQty: updated.totalQty - updated.reservedQty,
    });
  },
);

app.put(
  "/api/admin/inventory/:id/sold",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const { soldQty } = req.body;
    if (soldQty === undefined || soldQty < 0)
      return res.status(400).json({ error: "soldQty must be 0 or greater" });
    const inv = await prisma.inventory.findUnique({
      where: { id: req.params.id },
    });
    if (!inv) return res.status(404).json({ error: "Not found" });
    const updated = await prisma.inventory.update({
      where: { id: req.params.id },
      data: { soldQty: +soldQty },
    });
    res.json({
      ...updated,
      availableQty: updated.totalQty - updated.reservedQty,
    });
  },
);

app.get("/api/admin/inventory/export", async (req, res) => {
  // Accept token from query string (since window.open can't send headers)
  const token = req.query.token || req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const inv = await prisma.inventory.findMany({
    include: { product: { select: { name: true } } },
    orderBy: [{ product: { name: "asc" } }, { size: "asc" }],
  });
  const csv = [
    "Product,Size,Total,Reserved,Available,Sold",
    ...inv.map(
      (i) =>
        `"${i.product.name}",${i.size},${i.totalQty},${i.reservedQty},${i.totalQty - i.reservedQty},${i.soldQty || 0}`,
    ),
  ].join("\n");
  res
    .setHeader("Content-Type", "text/csv")
    .setHeader("Content-Disposition", "attachment; filename=inventory.csv")
    .send(csv);
});

app.get("/api/admin/inventory/available", async (req, res) => {
  const inv = await prisma.inventory.findMany({
    select: { productId: true, size: true, totalQty: true, reservedQty: true },
  });
  const map = {};
  inv.forEach((i) => {
    map[`${i.productId}-${i.size}`] = i.totalQty - i.reservedQty;
  });
  res.json(map);
});

// ─── ORDERS (ADMIN) ──────────────────────────────────────────

app.get("/api/admin/orders", adminMiddleware(), async (req, res) => {
  const { search, status, locationId, page = 1, limit = 50 } = req.query;
  const where = {};
  if (status) where.status = status;
  if (locationId) where.locationId = locationId;
  if (search)
    where.OR = [
      { childName: { contains: search, mode: "insensitive" } },
      { parentName: { contains: search, mode: "insensitive" } },
      { childClass: { contains: search, mode: "insensitive" } },
      { orderNumber: { contains: search, mode: "insensitive" } },
    ];
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: true, location: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (+page - 1) * +limit,
      take: +limit,
    }),
    prisma.order.count({ where }),
  ]);
  res.json({ orders, total, page: +page, pages: Math.ceil(total / +limit) });
});

app.get("/api/admin/orders/:id", adminMiddleware(), async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      items: true,
      location: true,
      parent: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!order) return res.status(404).json({ error: "Not found" });
  res.json(order);
});

app.put("/api/admin/orders/:id/status", adminMiddleware(), async (req, res) => {
  const { status } = req.body;
  const validStatuses = [
    "SUBMITTED",
    "REVIEW",
    "READY_FOR_PICKUP",
    "PICKED_UP",
    "PAID",
    "CANCELLED",
  ];
  if (!validStatuses.includes(status))
    return res.status(400).json({ error: "Invalid status" });
  const current = await prisma.order.findUnique({
    where: { id: req.params.id },
  });
  if (!current) return res.status(404).json({ error: "Order not found" });
  if (current.status === status) return res.json(current);
  const updated = await prisma.$transaction(async (tx) => {
    await applyInventoryTransition(req.params.id, current.status, status, tx);
    return tx.order.update({
      where: { id: req.params.id },
      data: {
        status,
        statusHistory: {
          push: {
            status,
            changedAt: new Date().toISOString(),
            changedBy: req.user.id,
            changedByName: "Admin",
          },
        },
      },
      include: { items: true, location: { select: { name: true } } },
    });
  });
  res.json(updated);
  // Notify parent of status change
  if (process.env.RESEND_API_KEY) {
    const parentRecord = await prisma.parent.findUnique({
      where: { id: updated.parentId },
      select: { email: true },
    });
    if (parentRecord) {
      const statusLabels = {
        REVIEW: "Your order is under review",
        READY_FOR_PICKUP: "🎉 Your order is ready for pick up!",
        CANCELLED: "Your order has been cancelled",
        PAID: "✅ Payment received — thank you!",
        PICKED_UP: "Order marked as picked up — thank you!",
      };
      const message = statusLabels[status];
      if (message) {
        resend.emails
          .send({
            from: process.env.EMAIL_FROM,
            to: parentRecord.email,
            subject: `${message} — ${updated.orderNumber}`,
            html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1a7a55;padding:24px 32px;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:20px">Order Update</h1>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
              <p>Hi there,</p>
              <p style="font-size:18px;font-weight:700;color:#1a7a55">${message}</p>
              <p>Order: <strong>${updated.orderNumber}</strong></p>
              <p style="color:#666;font-size:13px">If you have any questions please contact the school office.</p>
               ${footerHtml}
            </div>
          </div>`,
          })
          .catch((err) => console.warn("Status email failed:", err.message));
      }
    }
  }
});

app.get("/api/admin/orders/export", async (req, res) => {
  // Accept token from query string since window.open can't send headers
  const token = req.query.token || req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const orders = await prisma.order.findMany({
    include: { items: true, location: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const rows = [
    [
      "Order#",
      "Date",
      "Child",
      "Class",
      "Parent",
      "Phone",
      "Location",
      "Subtotal",
      "Discount",
      "Total",
      "Status",
    ],
  ];
  for (const o of orders)
    rows.push([
      o.orderNumber,
      o.createdAt.toISOString().split("T")[0],
      o.childName,
      o.childClass,
      o.parentName,
      o.parentPhone,
      o.location.name,
      o.subtotal,
      o.discountAmount,
      o.totalAmount,
      o.status,
    ]);
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  res
    .setHeader("Content-Type", "text/csv")
    .setHeader("Content-Disposition", "attachment; filename=orders.csv")
    .send(csv);
});

// ─── DASHBOARD STATS ─────────────────────────────────────────

app.get("/api/admin/stats", adminMiddleware(), async (req, res) => {
  const [totalOrders, pendingOrders, revenueData] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: { in: ["SUBMITTED", "REVIEW"] } } }),
    prisma.order.aggregate({
      where: { status: { notIn: ["CANCELLED"] } },
      _sum: { totalAmount: true },
    }),
  ]);
  const orderItems = await prisma.orderItem.findMany({
    include: {
      product: { select: { costPrice: true } },
      order: { select: { status: true } },
    },
  });
  const profit = orderItems
    .filter((i) => i.order.status !== "CANCELLED")
    .reduce(
      (s, i) =>
        s +
        (parseFloat(i.product.costPrice) - parseFloat(i.unitPrice)) *
          -1 *
          i.quantity,
      0,
    );
  const productStats = await prisma.orderItem.groupBy({
    by: ["productId", "productName"],
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: 10,
  });
  res.json({
    totalOrders,
    pendingOrders,
    revenue: parseFloat(revenueData._sum.totalAmount || 0),
    profit: +profit.toFixed(2),
    topProducts: productStats,
  });
});

// ─── LOCATIONS ───────────────────────────────────────────────

app.get("/api/admin/locations", adminMiddleware(), async (req, res) => {
  res.json(await prisma.location.findMany({ orderBy: { sortOrder: "asc" } }));
});

app.post(
  "/api/admin/locations",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const { name, sortOrder } = req.body;
    res.status(201).json(
      await prisma.location.create({
        data: { name, sortOrder: sortOrder || 0 },
      }),
    );
  },
);

app.put(
  "/api/admin/locations/:id",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const { name, isActive, isDefault, sortOrder } = req.body;
    if (isDefault)
      await prisma.location.updateMany({
        where: { NOT: { id: req.params.id } },
        data: { isDefault: false },
      });
    res.json(
      await prisma.location.update({
        where: { id: req.params.id },
        data: { name, isActive, isDefault, sortOrder },
      }),
    );
  },
);

app.delete(
  "/api/admin/locations/:id",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    const hasOrders = await prisma.order.count({
      where: { locationId: req.params.id },
    });
    if (hasOrders)
      return res.status(409).json({
        error:
          "Cannot delete location with existing orders. Deactivate it instead.",
      });
    await prisma.location.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  },
);

// ─── SETTINGS ────────────────────────────────────────────────

app.get("/api/admin/settings", adminMiddleware(), async (req, res) => {
  res.json(
    await prisma.siteSettings.findUnique({ where: { id: "singleton" } }),
  );
});

app.put(
  "/api/admin/settings",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const {
      systemName,
      logoEmoji,
      logoUrl,
      welcomeTitle,
      welcomeText,
      orderInstructions,
      noticeText,
      discountThreshold,
      discountRate,
      adminEmails,
      orderStockThreshold,
    } = req.body;
    res.json(
      await prisma.siteSettings.upsert({
        where: { id: "singleton" },
        update: {
          systemName,
          logoEmoji,
          logoUrl,
          welcomeTitle,
          welcomeText,
          orderInstructions,
          noticeText,
          discountThreshold: discountThreshold ? +discountThreshold : undefined,
          discountRate: discountRate ? +discountRate : undefined,
          adminEmails: adminEmails ?? undefined,
          orderStockThreshold:
            orderStockThreshold !== undefined
              ? +orderStockThreshold
              : undefined,
        },
        create: {
          id: "singleton",
          systemName,
          logoEmoji,
          logoUrl,
          welcomeTitle,
          welcomeText,
          orderInstructions,
          noticeText,
          discountThreshold: +discountThreshold || 500,
          discountRate: +discountRate || 0.15,
          adminEmails: adminEmails ?? undefined,
          orderStockThreshold:
            orderStockThreshold !== undefined
              ? +orderStockThreshold
              : undefined,
        },
      }),
    );
  },
);

// ─── LOGO IMAGE UPLOAD ───────────────────────────────────────

app.post(
  "/api/admin/settings/logo",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  upload.single("logo"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const ext = path.extname(req.file.originalname).toLowerCase() || ".jpg";
    const filename = `logo-${Date.now()}${ext}`;
    const logoUrl = await uploadFile(
      req.file.buffer || req.file.path,
      filename,
      req.file.mimetype,
    );
    console.log(logoUrl);
    // Save to settings
    await prisma.siteSettings.upsert({
      where: { id: "singleton" },
      update: { logoUrl },
      create: {
        id: "singleton",
        logoUrl,
        discountThreshold: 500,
        discountRate: 0.15,
      },
    });
    res.json({ logoUrl });
  },
);

// ─── FORM FIELDS ─────────────────────────────────────────────

app.get("/api/admin/form-fields", adminMiddleware(), async (req, res) => {
  res.json(await prisma.formField.findMany({ orderBy: { sortOrder: "asc" } }));
});

app.put(
  "/api/admin/form-fields",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const { fields } = req.body;

    // Use upsert so that:
    // - Existing fields (real DB id) → updated in place
    // - Newly added fields sent with a temp id → created fresh
    // A "temp" id is anything that doesn't look like a cuid (doesn't start with 'c'
    // or is shorter than 20 chars). We detect by trying update first and falling
    // back to create, but the cleanest approach is upsert on fieldKey (unique).
    await Promise.all(
      fields.map((f) => {
        const data = {
          label: f.label,
          fieldType: f.fieldType || "text",
          isVisible: f.isVisible ?? true,
          isRequired: f.isRequired ?? false,
          isSystem: f.isSystem ?? false,
          sortOrder: f.sortOrder ?? 99,
        };
        return prisma.formField.upsert({
          where: { fieldKey: f.fieldKey },
          update: data,
          create: { ...data, fieldKey: f.fieldKey },
        });
      }),
    );
    res.json({ ok: true });
  },
);

app.post(
  "/api/admin/form-fields",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    const { label, fieldKey, fieldType, isRequired, sortOrder, options } =
      req.body;
    res.status(201).json(
      await prisma.formField.create({
        data: {
          label,
          fieldKey,
          fieldType: fieldType || "text",
          isRequired: isRequired ?? false,
          isVisible: true,
          isSystem: false,
          sortOrder: sortOrder || 99,
          options,
        },
      }),
    );
  },
);

app.delete(
  "/api/admin/form-fields/:id",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    const field = await prisma.formField.findUnique({
      where: { id: req.params.id },
    });
    if (field?.isSystem)
      return res.status(403).json({ error: "Cannot delete system fields" });
    await prisma.formField.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  },
);

// ─── ADMIN ACCOUNTS ──────────────────────────────────────────

app.get(
  "/api/admin/accounts",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    res.json(
      await prisma.admin.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      }),
    );
  },
);

app.post(
  "/api/admin/accounts",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "name, email, password required" });
    const hashed = await bcrypt.hash(password, 12);
    const admin = await prisma.admin.create({
      data: { name, email, password: hashed, role: role || "STAFF" },
    });
    res.status(201).json({
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    });
  },
);

app.put(
  "/api/admin/accounts/:id",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    const { name, role, isActive, password } = req.body;

    // Guard: cannot demote or deactivate the last SUPER_ADMIN
    const current = await prisma.admin.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ error: "Account not found" });

    if (
      current.role === "SUPER_ADMIN" &&
      (role !== "SUPER_ADMIN" || isActive === false)
    ) {
      const superAdminCount = await prisma.admin.count({
        where: { role: "SUPER_ADMIN", isActive: true },
      });
      if (superAdminCount <= 1)
        return res.status(409).json({
          error: "Cannot demote or deactivate the last Super Admin account",
        });
    }

    const data = { name, role, isActive };
    if (password) data.password = await bcrypt.hash(password, 12);

    res.json(
      await prisma.admin.update({
        where: { id: req.params.id },
        data,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
        },
      }),
    );
  },
);

app.delete(
  "/api/admin/accounts/:id",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    const current = await prisma.admin.findUnique({
      where: { id: req.params.id },
    });
    if (!current) return res.status(404).json({ error: "Account not found" });

    // Guard: cannot delete the last SUPER_ADMIN
    if (current.role === "SUPER_ADMIN") {
      const superAdminCount = await prisma.admin.count({
        where: { role: "SUPER_ADMIN", isActive: true },
      });
      if (superAdminCount <= 1)
        return res.status(409).json({
          error: "Cannot delete the last Super Admin account",
        });
    }

    await prisma.admin.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  },
);

app.get("/api/admin/parents", adminMiddleware(), async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;
  const where = search
    ? {
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
        ],
      }
    : {};
  const [parents, total] = await Promise.all([
    prisma.parent.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        isActive: true,
        createdAt: true,
        _count: { select: { orders: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (+page - 1) * +limit,
      take: +limit,
    }),
    prisma.parent.count({ where }),
  ]);
  res.json({ parents, total, page: +page, pages: Math.ceil(total / +limit) });
});

app.put(
  "/api/admin/parents/:id",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const { isActive, firstName, lastName, phone, email } = req.body;
    const parent = await prisma.parent.findUnique({
      where: { id: req.params.id },
    });
    if (!parent) return res.status(404).json({ error: "Parent not found" });
    const updated = await prisma.parent.update({
      where: { id: req.params.id },
      data: {
        ...(isActive !== undefined && { isActive }),
        ...(firstName && { firstName }),
        ...(lastName && { lastName }),
        ...(phone !== undefined && { phone }),
        ...(email && { email }),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        isActive: true,
      },
    });
    res.json(updated);
  },
);

// ─── ERROR HANDLER ───────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === "P2025")
    return res.status(404).json({ error: "Record not found" });
  if (err.code === "P2002")
    return res.status(409).json({ error: "Duplicate record" });
  if (err.message?.startsWith("Unsupported file type"))
    return res.status(415).json({ error: err.message });
  if (err.code === "LIMIT_FILE_SIZE")
    return res
      .status(413)
      .json({ error: "File too large. Maximum size is 8 MB per image." });
  if (err.code === "LIMIT_FILE_COUNT")
    return res
      .status(400)
      .json({ error: "Too many files. Maximum is 10 images per upload." });
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => console.log(`Wonderworld API running on :${PORT}`));

export default app;
