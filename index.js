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
  if (emails.length > 0) return emails;
  return process.env.ADMIN_EMAIL ? [process.env.ADMIN_EMAIL] : [];
}

// Convert internal size code to display format: T1 → 1T, T2 → 2T etc.
function displaySize(s) {
  if (!s) return s;
  return s.replace(/^T(\d+)$/, "$1T");
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
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${displaySize(i.size)}</td>
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
       <div style="margin-top:20px;padding:14px 16px;background:#fdf8ec;border-left:4px solid #d4a843;border-radius:6px">
        <p style="margin:0 0 6px 0;font-weight:700;font-size:13px;color:#8a6a10">📋 Return &amp; Exchange Policy</p>
        <p style="margin:0 0 8px 0;font-size:12px;color:#555;line-height:1.6">
          All uniform orders are final — we are unable to issue refunds once an order has been placed and paid. Size exchanges may be available depending on current stock availability.
        </p>
        <p style="margin:0;font-size:12px;color:#555;line-height:1.6">
          <strong>Pick-Up:</strong> You will receive an email when your uniform order is ready for pick-up at the school front desk.
        </p>
      </div>
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

    if (
      PENDING_STATUSES.includes(toStatus) &&
      !PENDING_STATUSES.includes(fromStatus) &&
      !SOLD_STATUSES.includes(fromStatus)
    ) {
      // Any → PENDING (only from non-pending, non-sold)
      update = { reservedQty: { increment: item.quantity } };
    } else if (
      SOLD_STATUSES.includes(toStatus) &&
      PENDING_STATUSES.includes(fromStatus)
    ) {
      // PENDING → SOLD
      update = {
        totalQty: { decrement: item.quantity },
        reservedQty: { decrement: item.quantity },
        soldQty: { increment: item.quantity },
      };
    } else if (
      SOLD_STATUSES.includes(toStatus) &&
      SOLD_STATUSES.includes(fromStatus)
    ) {
      // SOLD → SOLD (no movement)
      update = {};
    } else if (
      SOLD_STATUSES.includes(fromStatus) &&
      PENDING_STATUSES.includes(toStatus)
    ) {
      // SOLD → PENDING (reverse)
      update = {
        totalQty: { increment: item.quantity },
        reservedQty: { increment: item.quantity },
        soldQty: { decrement: item.quantity },
      };
    } else if (toStatus === "CANCELLED") {
      if (PENDING_STATUSES.includes(fromStatus)) {
        update = { reservedQty: { decrement: item.quantity } };
      } else if (SOLD_STATUSES.includes(fromStatus)) {
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

// ─── INVENTORY / ORDERS AUDIT ──────────────────────────────────
// Recomputes what reservedQty/soldQty *should* be from live order data
// and diffs it against the Inventory table. Backs both the admin "Stock
// Audit" page and scripts/audit-inventory.js (keep the two in sync if you
// change this).
const AUDIT_PENDING_STATUSES = ["SUBMITTED", "REVIEW"];
const AUDIT_SOLD_STATUSES = ["PAID", "READY_FOR_PICKUP", "PICKED_UP"];
const AUDIT_KNOWN_STATUSES = new Set([
  ...AUDIT_PENDING_STATUSES,
  ...AUDIT_SOLD_STATUSES,
  "CANCELLED",
]);

async function computeInventoryAudit(db) {
  const [inventory, orders, products] = await Promise.all([
    db.inventory.findMany(),
    db.order.findMany({
      where: { status: { not: "CANCELLED" } },
      select: { id: true, orderNumber: true, status: true, items: true },
    }),
    db.product.findMany({ select: { id: true, name: true } }),
  ]);

  const productNames = Object.fromEntries(products.map((p) => [p.id, p.name]));

  const expected = {};
  const bump = (key, field, qty) => {
    if (!expected[key]) expected[key] = { reserved: 0, sold: 0 };
    expected[key][field] += qty;
  };

  const unknownStatusOrders = [];
  for (const order of orders) {
    if (!AUDIT_KNOWN_STATUSES.has(order.status)) {
      unknownStatusOrders.push({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
      });
      continue;
    }
    const bucket = AUDIT_PENDING_STATUSES.includes(order.status)
      ? "reserved"
      : "sold";
    for (const item of order.items) {
      bump(`${item.productId}-${item.size}`, bucket, item.quantity);
    }
  }

  const issues = [];
  for (const inv of inventory) {
    const key = `${inv.productId}-${inv.size}`;
    const exp = expected[key] || { reserved: 0, sold: 0 };
    const productName = productNames[inv.productId] || "(unknown product)";
    const available = inv.totalQty - inv.reservedQty;
    const soldQty = inv.soldQty ?? 0;

    const problems = [];
    if (inv.reservedQty !== exp.reserved) {
      problems.push(
        `reservedQty is ${inv.reservedQty}, but SUBMITTED/REVIEW orders account for ${exp.reserved}.`,
      );
    }
    if (soldQty !== exp.sold) {
      problems.push(
        `soldQty is ${soldQty}, but PAID/READY_FOR_PICKUP/PICKED_UP orders account for ${exp.sold}.`,
      );
    }
    if (available < 0) {
      problems.push(
        `availableQty is ${available} (totalQty ${inv.totalQty} < reservedQty ${inv.reservedQty}) — oversold.`,
      );
    }
    if (inv.totalQty < 0 || inv.reservedQty < 0 || soldQty < 0) {
      problems.push(
        `negative raw value(s): total=${inv.totalQty}, reserved=${inv.reservedQty}, sold=${soldQty}.`,
      );
    }

    if (problems.length) {
      issues.push({
        inventoryId: inv.id,
        productId: inv.productId,
        product: productName,
        size: displaySize(inv.size),
        totalQty: inv.totalQty,
        reservedQty: inv.reservedQty,
        soldQty,
        availableQty: available,
        expectedReserved: exp.reserved,
        expectedSold: exp.sold,
        problems,
      });
    }
  }

  const invKeys = new Set(inventory.map((i) => `${i.productId}-${i.size}`));
  const orphans = Object.keys(expected)
    .filter((k) => !invKeys.has(k))
    .map((key) => {
      const [productId, size] = key.split("-");
      return {
        productId,
        size: displaySize(size),
        product: productNames[productId] || "(unknown product)",
        expectedReserved: expected[key].reserved,
        expectedSold: expected[key].sold,
      };
    });

  return { issues, orphans, unknownStatusOrders };
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
  const { firstName, lastName, email, phone, password, children } = req.body;
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
  if (children?.length) {
    await prisma.child.createMany({
      data: children.map((c) => ({
        parentId: parent.id,
        firstName: c.firstName.trim(),
        lastName: c.lastName.trim(),
        class: c.class?.trim() || null,
      })),
    });
  }
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

  const parentWithChildren = await prisma.parent.findUnique({
    where: { id: parent.id },
    include: { children: { orderBy: { createdAt: "asc" } } },
  });
  const token = signToken({ id: parent.id, type: "parent" });
  res.json({
    token,
    mustChangePassword: parent.mustChangePassword,
    parent: parentWithChildren,
    // parent: {
    //   id: parent.id,
    //   firstName: parent.firstName,
    //   lastName: parent.lastName,
    //   email: parent.email,
    //   phone: parent.phone,
    // },
  });
});

app.put(
  "/api/auth/parent/change-password",
  parentMiddleware,
  async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6)
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    const hashed = await bcrypt.hash(newPassword, 12);
    await prisma.parent.update({
      where: { id: req.user.id },
      data: { password: hashed, mustChangePassword: false },
    });
    res.json({ ok: true });
  },
);

app.get("/api/parents/children", parentMiddleware, async (req, res) => {
  const children = await prisma.child.findMany({
    where: { parentId: req.user.id },
    orderBy: { createdAt: "asc" },
  });
  res.json(children);
});

app.post("/api/parents/children", parentMiddleware, async (req, res) => {
  const { firstName, lastName, class: childClass } = req.body;
  if (!firstName?.trim() || !lastName?.trim())
    return res.status(400).json({ error: "First and last name are required" });
  const child = await prisma.child.create({
    data: {
      parentId: req.user.id,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      class: childClass?.trim() || null,
    },
  });
  res.status(201).json(child);
});

app.delete("/api/parents/children/:id", parentMiddleware, async (req, res) => {
  const child = await prisma.child.findUnique({ where: { id: req.params.id } });
  if (!child || child.parentId !== req.user.id)
    return res.status(404).json({ error: "Child not found" });
  await prisma.child.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

app.put("/api/parents/children/:id", parentMiddleware, async (req, res) => {
  const { firstName, lastName, class: childClass } = req.body;
  if (!firstName?.trim() || !lastName?.trim())
    return res.status(400).json({ error: "First and last name are required" });
  const updated = await prisma.child.update({
    where: { id: req.params.id },
    data: {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      class: childClass?.trim() || null,
    },
  });
  res.json(updated);
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
    childId,
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
      if (item.quantity > available) {
        return res.status(400).json({
          error: `Insufficient stock for ${item.productName} (${displaySize(item.size)}). Requested: ${item.quantity}, Available: ${available}.`,
        });
      }
    }
  }

  const threshold = parseFloat(settings?.discountThreshold || 500);
  const discountRate =
    settings?.discountRate !== undefined && settings?.discountRate !== null
      ? parseFloat(settings.discountRate)
      : 0.15;

  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

  // Check if this child has had a previous non-cancelled order
  const previousOrderCount = await prisma.order.count({
    where: {
      parentId: req.user.id,
      status: { notIn: ["CANCELLED"] },
      ...(childId
        ? { childId }
        : { childName: { equals: childName, mode: "insensitive" } }),
    },
  });
  const isFirstOrder = previousOrderCount === 0;
  const appliedRate = subtotal >= threshold && isFirstOrder ? discountRate : 0;

  const discountAmount = +(subtotal * appliedRate).toFixed(2);
  const totalAmount = +(subtotal - discountAmount).toFixed(2);
  const orderNumber = await generateOrderNumber(locationId);
  const parent = await prisma.parent.findUnique({ where: { id: req.user.id } });

  let order;
  try {
    order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          parentId: req.user.id,
          childId: childId || null,
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
      // Re-check stock and reserve it atomically inside the transaction.
      // The earlier check (above, before the transaction started) is only a
      // fast pre-check for UX -- it can go stale if two parents check out
      // at the same time, so it must never be the only thing standing
      // between reservedQty and totalQty. We use a compare-and-swap update
      // here (matching on the reservedQty we just read) so that if another
      // request reserved stock in between, this update affects 0 rows and
      // we can detect and reject the conflict instead of silently
      // over-reserving stock.
      for (const item of newOrder.items) {
        const inv = await tx.inventory.findUnique({
          where: {
            productId_size: { productId: item.productId, size: item.size },
          },
        });
        if (!inv) continue;
        const available = inv.totalQty - inv.reservedQty;
        if (
          orderStockThreshold > 0 &&
          available - item.quantity < orderStockThreshold
        ) {
          throw Object.assign(
            new Error(
              `Insufficient stock for ${item.productName} (${displaySize(item.size)}). Requested: ${item.quantity}, Available: ${available}.`,
            ),
            { isStockError: true },
          );
        }
        const result = await tx.inventory.updateMany({
          where: {
            productId: item.productId,
            size: item.size,
            reservedQty: inv.reservedQty,
          },
          data: { reservedQty: { increment: item.quantity } },
        });
        if (result.count === 0) {
          throw Object.assign(
            new Error(
              `Stock for ${item.productName} (${displaySize(item.size)}) just changed -- please review your cart and try again.`,
            ),
            { isStockError: true },
          );
        }
      }
      return newOrder;
    });
  } catch (err) {
    if (err.isStockError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
  // Send confirmation emails (non-blocking — won't fail the order if email fails)
  sendOrderEmails(order, parent.email).catch((err) =>
    console.warn("Email send failed:", err.message),
  );
  res.status(201).json(order);
});

app.get("/api/orders/check-first-order", parentMiddleware, async (req, res) => {
  const { childName, childId } = req.query;
  const where = {
    parentId: req.user.id,
    status: { notIn: ["CANCELLED"] },
    ...(childId
      ? { childId }
      : childName
        ? { childName: { equals: childName.trim(), mode: "insensitive" } }
        : {}),
  };
  const count = await prisma.order.count({ where });
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
      sizes,
    } = req.body;

    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
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

      if (Array.isArray(sizes)) {
        const existingSizes = updated.inventory.map((i) => i.size);

        // Add new sizes
        const toAdd = sizes.filter((s) => !existingSizes.includes(s));
        if (toAdd.length) {
          await tx.inventory.createMany({
            data: toAdd.map((s) => ({
              productId: req.params.id,
              size: s,
              totalQty: 0,
              reservedQty: 0,
              soldQty: 0,
            })),
          });
        }

        // Remove unchecked sizes — only if no reservations or sales
        const toRemove = existingSizes.filter((s) => !sizes.includes(s));
        for (const s of toRemove) {
          const inv = updated.inventory.find((i) => i.size === s);
          if (inv && inv.reservedQty === 0 && (inv.soldQty ?? 0) === 0) {
            await tx.inventory.delete({ where: { id: inv.id } });
          }
        }

        return tx.product.findUnique({
          where: { id: req.params.id },
          include: { inventory: true },
        });
      }

      return updated;
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
    const newTotal = +totalQty;
    if (!Number.isFinite(newTotal) || newTotal < 0)
      return res
        .status(400)
        .json({ error: "totalQty must be a non-negative number" });
    if (newTotal < inv.reservedQty)
      return res.status(400).json({
        error: `Cannot set total (${newTotal}) below reserved (${inv.reservedQty}). ${inv.reservedQty} unit(s) are held by pending orders.`,
      });
    const updated = await prisma.inventory.update({
      where: { id: req.params.id },
      data: { totalQty: newTotal },
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

    const oldSold = inv.soldQty ?? 0;
    const diff = +soldQty - oldSold; // positive = more sold, negative = return

    // Auto-adjust totalQty:
    // If sold increases → totalQty decreases (items left inventory)
    // If sold decreases → totalQty increases (items returned to stock)
    const newTotal = inv.totalQty - diff;

    // Previously this silently clamped negative totals to 0 with
    // Math.max(0, ...), which desynced totalQty from the soldQty the
    // admin actually entered (e.g. soldQty=50 but totalQty artificially
    // floored at 0 even though the math implied a negative stock count).
    // Reject instead so the numbers on screen always add up.
    if (newTotal < 0)
      return res.status(400).json({
        error: `That would require ${-newTotal} more unit(s) than currently in stock (${inv.totalQty}).`,
      });
    // Also make sure we never drop total stock below what's still
    // reserved for pending orders — otherwise availableQty goes negative.
    if (newTotal < inv.reservedQty)
      return res.status(400).json({
        error: `Cannot set sold this high — it would drop total stock (${newTotal}) below reserved (${inv.reservedQty}).`,
      });

    const updated = await prisma.inventory.update({
      where: { id: req.params.id },
      data: {
        soldQty: +soldQty,
        totalQty: newTotal,
      },
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
    where: { product: { isActive: true } },
    include: { product: { select: { name: true, isActive: true } } },
    orderBy: [{ product: { name: "asc" } }, { size: "asc" }],
  });
  const csv = [
    "Product,Size,Current,Reserved,Available,Sold",
    ...inv.map(
      (i) =>
        `"${i.product.name}",${displaySize(i.size)},${i.totalQty},${i.reservedQty},${i.totalQty - i.reservedQty},${i.soldQty || 0}`,
    ),
  ].join("\n");
  res
    .setHeader("Content-Type", "text/csv")
    .setHeader("Content-Disposition", "attachment; filename=inventory.csv")
    .send(csv);
});

app.get("/api/admin/inventory/available", async (req, res) => {
  const inv = await prisma.inventory.findMany({
    select: {
      productId: true,
      size: true,
      totalQty: true,
      reservedQty: true,
      soldQty: true,
    },
  });
  const map = {};
  inv.forEach((i) => {
    map[`${i.productId}-${i.size}`] = i.totalQty - i.reservedQty;
  });
  res.json(map);
});

/**
 * GET /api/admin/inventory/audit
 * Read-only: recomputes reservedQty/soldQty from live order data and
 * reports any drift from the Inventory table. Powers the admin "Stock
 * Audit" page.
 */
app.get(
  "/api/admin/inventory/audit",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const result = await computeInventoryAudit(prisma);
    res.json(result);
  },
);

/**
 * POST /api/admin/inventory/audit/fix
 * Repairs reservedQty/soldQty to match what the orders table implies.
 * Never touches totalQty — physical stock counts aren't derivable from
 * orders alone, so any remaining "oversold" issue after this still needs
 * a human to check the actual stock on the shelf.
 */
app.post(
  "/api/admin/inventory/audit/fix",
  adminMiddleware(["SUPER_ADMIN", "MANAGER"]),
  async (req, res) => {
    const before = await computeInventoryAudit(prisma);
    if (before.issues.length) {
      await prisma.$transaction(
        before.issues.map((row) =>
          prisma.inventory.update({
            where: { id: row.inventoryId },
            data: {
              reservedQty: row.expectedReserved,
              soldQty: row.expectedSold,
            },
          }),
        ),
      );
    }
    const after = await computeInventoryAudit(prisma);
    res.json({ ...after, fixedCount: before.issues.length });
  },
);

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
  const [rawOrders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        items: {
          include: { product: { select: { name: true } } },
        },
        location: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (+page - 1) * +limit,
      take: +limit,
    }),
    prisma.order.count({ where }),
  ]);

  const orders = rawOrders.map((o) => ({
    ...o,
    items: o.items.map((item) => ({
      ...item,
      productName: item.product?.name || item.productName,
    })),
  }));
  res.json({ orders, total, page: +page, pages: Math.ceil(total / +limit) });
});
app.get("/api/admin/orders/export", async (req, res) => {
  // Accept token from query string since window.open can't send headers;
  const token = req.query.token || req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const orders = await prisma.order.findMany({
    include: {
      items: {
        include: {
          product: { select: { name: true } },
        },
      },
      location: { select: { name: true } },
    },
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
      "Item",
      "Size",
      "Qty",
      "Unit Price",
      "Subtotal",
      "Discount",
      "Total",
      "Status",
    ],
  ];
  for (const o of orders) {
    if (o.items.length === 0) {
      rows.push([
        o.orderNumber,
        o.createdAt.toISOString().split("T")[0],
        o.childName,
        o.childClass,
        o.parentName,
        o.parentPhone,
        o.location.name,
        "",
        "",
        "",
        "",
        o.subtotal,
        o.discountAmount,
        o.totalAmount,
        o.status,
      ]);
    } else {
      o.items.forEach((item, idx) => {
        rows.push([
          idx === 0 ? o.orderNumber : "", // only show order# on first row
          idx === 0 ? o.createdAt.toISOString().split("T")[0] : "",
          idx === 0 ? o.childName : "",
          idx === 0 ? o.childClass : "",
          idx === 0 ? o.parentName : "",
          idx === 0 ? o.parentPhone : "",
          idx === 0 ? o.location.name : "",
          item.product?.name || item.productName,
          displaySize(item.size),
          item.quantity,
          Number(item.unitPrice).toFixed(2),
          idx === 0 ? o.subtotal : "", // only show totals on first row
          idx === 0 ? o.discountAmount : "",
          idx === 0 ? o.totalAmount : "",
          idx === 0 ? o.status : "",
        ]);
      });
    }
  }
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  res
    .setHeader("Content-Type", "text/csv")
    .setHeader("Content-Disposition", "attachment; filename=orders.csv")
    .send(csv);
});

app.get("/api/admin/orders/:id", adminMiddleware(), async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      items: {
        include: {
          product: { select: { name: true } },
        },
      },
      location: true,
      parent: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!order) return res.status(404).json({ error: "Not found" });

  // Override stored productName with current product name if available
  const enriched = {
    ...order,
    items: order.items.map((item) => ({
      ...item,
      productName: item.product?.name || item.productName,
    })),
  };

  res.json(enriched);
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
  // Prevent changing status once cancelled
  if (current.status === "CANCELLED") {
    return res.status(400).json({
      error: "Cancelled orders cannot be updated.",
    });
  }

  // Prevent cancelling a picked up order
  if (current.status === "PICKED_UP" && status === "CANCELLED") {
    return res.status(400).json({
      error: "Picked up orders cannot be cancelled.",
    });
  }

  // Prevent changing status once picked up
  if (current.status === "PICKED_UP") {
    return res.status(400).json({
      error: "Picked up orders cannot be updated.",
    });
  }
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
        // REVIEW: "Your order is under review",
        READY_FOR_PICKUP: "🎉 Your order is ready for pick up!",
        // CANCELLED: "Your order has been cancelled",
        PAID: "✅ Payment received — thank you!",
        // PICKED_UP: "Order marked as picked up — thank you!",
      };
      const message = statusLabels[status];
      if (message) {
        // Build full order detail HTML (same structure as new order email)
        const statusItemsHtml = updated.items
          .map(
            (i) => `
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #eee">${i.productName}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${displaySize(i.size)}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${i.quantity}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">$${Number(i.unitPrice).toFixed(2)}</td>
              </tr>`,
          )
          .join("");

        const statusOrderSummaryHtml = `
              <table style="width:100%;border-collapse:collapse;margin:16px 0">
                <thead>
                  <tr style="background:#f7f8fa">
                    <th style="padding:8px 12px;text-align:left">Item</th>
                    <th style="padding:8px 12px;text-align:center">Size</th>
                    <th style="padding:8px 12px;text-align:center">Qty</th>
                    <th style="padding:8px 12px;text-align:right">Price</th>
                  </tr>
                </thead>
                <tbody>${statusItemsHtml}</tbody>
              </table>
              <table style="width:100%;margin-top:8px">
                <tr><td style="padding:4px 12px;color:#666">Subtotal</td><td style="padding:4px 12px;text-align:right">$${Number(updated.subtotal).toFixed(2)}</td></tr>
                ${Number(updated.discountAmount) > 0 ? `<tr><td style="padding:4px 12px;color:#e05a2b">Discount</td><td style="padding:4px 12px;text-align:right;color:#e05a2b">-$${Number(updated.discountAmount).toFixed(2)}</td></tr>` : ""}
                <tr style="font-weight:700;font-size:16px"><td style="padding:8px 12px;border-top:2px solid #eee">Total</td><td style="padding:8px 12px;text-align:right;border-top:2px solid #eee;color:#1a7a55">$${Number(updated.totalAmount).toFixed(2)}</td></tr>
              </table>`;
        resend.emails
          .send({
            from: process.env.EMAIL_FROM,
            to: parentRecord.email,
            subject: `${message} — ${updated.orderNumber}`,
            html: `
         <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1d23">
          <div style="background:#1a7a55;padding:24px 32px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:20px">Order Update</h1>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
            <p>Hi <strong>${updated.parentName}</strong>,</p>
            <p style="font-size:17px;font-weight:700;color:#1a7a55">${message}</p>
            <div style="background:#f7f8fa;border-radius:8px;padding:16px;margin:16px 0">
              <p style="margin:0 0 4px 0;font-size:13px;color:#666">Order Number</p>
              <p style="margin:0;font-size:20px;font-weight:700;color:#1a7a55">${updated.orderNumber}</p>
            </div>
            <p><strong>Child:</strong> ${updated.childName} · ${updated.childClass}</p>
            ${statusOrderSummaryHtml}
            <p style="color:#666;font-size:13px;margin-top:24px">If you have any questions please contact the school office.</p>
            ${footerHtml}
          </div>
        </div>`,
          })
          .catch((err) => console.warn("Status email failed:", err.message));
      }
    }
  }
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
    // take: 10,
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
          discountRate:
            discountRate === "" ||
            discountRate === undefined ||
            discountRate === null
              ? 0.15
              : +discountRate,
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
          {
            children: {
              some: {
                OR: [
                  { firstName: { contains: search, mode: "insensitive" } },
                  { lastName: { contains: search, mode: "insensitive" } },
                ],
              },
            },
          },
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
        children: { orderBy: { createdAt: "asc" } },
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
    const { isActive, firstName, lastName, phone, email, password } = req.body;
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
        ...(password && {
          password: await bcrypt.hash(password, 12),
          mustChangePassword: true,
        }),
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
app.delete(
  "/api/admin/parents/:id",
  adminMiddleware(["SUPER_ADMIN"]),
  async (req, res) => {
    const parent = await prisma.parent.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!parent) return res.status(404).json({ error: "Parent not found" });

    await prisma.$transaction(async (tx) => {
      // 1. Delete order items
      const orders = await tx.order.findMany({
        where: { parentId: req.params.id },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);

      if (orderIds.length > 0) {
        await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      // 2. Delete children — must happen before deleting parent due to foreign key
      await tx.child.deleteMany({ where: { parentId: req.params.id } });

      // 3. Delete parent
      await tx.parent.delete({ where: { id: req.params.id } });
    });

    res.json({ ok: true });
  },
);

app.get("/health", (req, res) => res.json({ ok: true }));

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
