/**
 * deleteOrder.js
 * ─────────────────────────────────────────────────────────────────
 * Deletes a single order by order number (e.g. "WW-1004") or by
 * internal database ID, and restores inventory where appropriate.
 *
 * Usage:
 *   node deleteOrder.js WW-1004
 *   node deleteOrder.js WW-1004 --dry-run      ← preview only, no changes
 *   node deleteOrder.js WW-1004 --confirm       ← actually delete
 *
 * Inventory restoration logic (mirrors applyInventoryTransition() in index.js):
 *   SUBMITTED / REVIEW                  → reservedQty restored
 *                                          (reservedQty -= item.quantity)
 *   READY_FOR_PICKUP / PICKED_UP / PAID → totalQty restored, soldQty reversed
 *                                          (totalQty += item.quantity, soldQty -= item.quantity —
 *                                          same reversal applyInventoryTransition() does when a
 *                                          sold order is cancelled)
 *   CANCELLED                           → no restoration (already reversed when cancelled)
 *
 * Any size-change requests attached to the order (pending, approved, or
 * rejected) are deleted along with the order — they only make sense in
 * the context of an order that still exists.
 *
 * Run from the server/ directory where your .env and prisma/ folder live.
 * ─────────────────────────────────────────────────────────────────
 */

import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

// ── Parse CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const orderRef = args[0];                              // order number or ID
const isDryRun = args.includes("--dry-run");
const isConfirmed = args.includes("--confirm");

if (!orderRef) {
  console.error("\n  Usage: node deleteOrder.js <orderNumber|id> [--dry-run | --confirm]\n");
  console.error("  Example: node deleteOrder.js WW-1004 --dry-run");
  console.error("  Example: node deleteOrder.js WW-1004 --confirm\n");
  process.exit(1);
}

if (!isDryRun && !isConfirmed) {
  console.error("\n  ⚠  You must pass either --dry-run or --confirm.\n");
  console.error("  Run with --dry-run first to preview what will happen.\n");
  process.exit(1);
}

// ── Statuses that need inventory restoration ───────────────────────
const RESTORE_RESERVED = ["SUBMITTED", "REVIEW"];
const RESTORE_SOLD     = ["READY_FOR_PICKUP", "PICKED_UP", "PAID"];
const NO_RESTORE       = ["CANCELLED"];

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  // 1. Find the order (by orderNumber OR by id)
  const order = await prisma.order.findFirst({
    where: {
      OR: [
        { orderNumber: orderRef },
        { id: orderRef },
      ],
    },
    include: {
      items: {
        include: {
          product: { select: { name: true } },
        },
      },
      parent: { select: { firstName: true, lastName: true, email: true } },
      changeRequests: true,
    },
  });

  if (!order) {
    console.error(`\n  ✗ Order "${orderRef}" not found.\n`);
    process.exit(1);
  }

  // 2. Print a clear summary of what will happen
  console.log("\n" + "─".repeat(60));
  console.log(isDryRun ? "  DRY RUN — no changes will be made" : "  DELETING ORDER");
  console.log("─".repeat(60));
  console.log(`  Order Number : ${order.orderNumber}`);
  console.log(`  Status       : ${order.status}`);
  console.log(`  Parent       : ${order.parent?.firstName} ${order.parent?.lastName} (${order.parent?.email})`);
  console.log(`  Child        : ${order.childName || "—"}  ${order.childClass ? `(${order.childClass})` : ""}`);
  console.log(`  Total        : $${Number(order.totalAmount).toFixed(2)}`);
  console.log(`  Submitted    : ${new Date(order.createdAt).toLocaleString()}`);
  console.log("");
  console.log("  Items:");

  for (const item of order.items) {
    console.log(`    • ${item.productName || item.product?.name}  size ${item.size}  qty ${item.quantity}  @ $${Number(item.unitPrice).toFixed(2)}`);
  }

  // 2b. Show any change requests that will be deleted with the order
  console.log("");
  if (order.changeRequests.length === 0) {
    console.log("  Change requests: none");
  } else {
    console.log(`  Change requests (${order.changeRequests.length}) — will be deleted with the order:`);
    for (const cr of order.changeRequests) {
      console.log(`    • [${cr.status}]  requested ${new Date(cr.requestedAt).toLocaleString()}`);
      for (const c of cr.changes) {
        console.log(`        ${c.productName}: ${c.fromSize} → ${c.toSize}`);
      }
      if (cr.status === "REJECTED" && cr.rejectionNote) {
        console.log(`        note: ${cr.rejectionNote}`);
      }
    }
  }

  // 3. Calculate inventory impact
  const willRestoreReserved = RESTORE_RESERVED.includes(order.status);
  const willRestoreSold     = RESTORE_SOLD.includes(order.status);
  const noRestore           = NO_RESTORE.includes(order.status);

  console.log("");
  console.log("  Inventory impact:");
  if (noRestore) {
    console.log("    ℹ  No inventory restoration needed (already reversed at cancellation).");
  } else if (willRestoreReserved) {
    for (const item of order.items) {
      console.log(`    ↩  ${item.productName}  (${item.size})  reservedQty − ${item.quantity}`);
    }
  } else if (willRestoreSold) {
    for (const item of order.items) {
      console.log(`    ↩  ${item.productName}  (${item.size})  totalQty + ${item.quantity},  soldQty − ${item.quantity}`);
    }
  }

  console.log("");

  if (isDryRun) {
    console.log("  ✓ Dry run complete. Run with --confirm to apply the deletion.");
    console.log("─".repeat(60) + "\n");
    return;
  }

  // 4. Execute inside a transaction
  await prisma.$transaction(async (tx) => {
    // 4a. Restore inventory if needed
    if (willRestoreReserved) {
      for (const item of order.items) {
        await tx.inventory.updateMany({
          where: { productId: item.productId, size: item.size },
          data: { reservedQty: { decrement: item.quantity } },
        });
      }
    } else if (willRestoreSold) {
      for (const item of order.items) {
        await tx.inventory.updateMany({
          where: { productId: item.productId, size: item.size },
          data: {
            totalQty: { increment: item.quantity },
            soldQty:  { decrement: item.quantity },
          },
        });
      }
    }

    // 4b. Delete change requests first (FK constraint)
    await tx.orderChangeRequest.deleteMany({ where: { orderId: order.id } });

    // 4c. Delete order items (FK constraint)
    await tx.orderItem.deleteMany({ where: { orderId: order.id } });

    // 4d. Delete the order
    await tx.order.delete({ where: { id: order.id } });
  });

  console.log(`  ✓ Order ${order.orderNumber} deleted successfully.`);
  if (order.changeRequests.length > 0) {
    console.log(`  ✓ ${order.changeRequests.length} change request(s) deleted.`);
  }
  if (!noRestore) {
    console.log("  ✓ Inventory restored.");
  }
  console.log("─".repeat(60) + "\n");
}

main()
  .catch((err) => {
    console.error("\n  ✗ Error:", err.message, "\n");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());


// # Preview first — no changes made
// node deleteOrder.js WW-1004 --dry-run

// # Actually delete
// node deleteOrder.js WW-1004 --confirm
