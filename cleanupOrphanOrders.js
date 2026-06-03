import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient();

async function main() {
  // Find all order items whose product no longer exists
  // Get all existing product IDs
  const existingProducts = await prisma.product.findMany({
    select: { id: true },
  });
  const existingProductIds = existingProducts.map((p) => p.id);

  // Find order items whose productId is not in the existing products list
  const orphanItems = await prisma.orderItem.findMany({
    where: {
      productId: { notIn: existingProductIds },
    },
    include: { order: true },
  });

  if (orphanItems.length === 0) {
    console.log("✅ No orphan order items found. Nothing to clean up.");
    return;
  }

  // Group by order
  const orderMap = new Map();
  for (const item of orphanItems) {
    if (!orderMap.has(item.orderId)) {
      orderMap.set(item.orderId, {
        order: item.order,
        items: [],
      });
    }
    orderMap.get(item.orderId).items.push(item);
  }

  console.log(
    `\nFound ${orphanItems.length} orphan order item(s) across ${orderMap.size} order(s):\n`,
  );
  for (const [orderId, { order, items }] of orderMap) {
    console.log(
      `  Order ${order.orderNumber} (${order.status}) — ${items.length} orphan item(s)`,
    );
    items.forEach((i) =>
      console.log(
        `    - productId: ${i.productId}, size: ${i.size}, qty: ${i.quantity}`,
      ),
    );
  }

  if (process.env.CONFIRM !== "true") {
    console.log(
      "\n⚠️  Run with CONFIRM=true to delete these orders and their items.",
    );
    return;
  }

  // Delete orphan orders and their items
  await prisma.$transaction(async (tx) => {
    const orderIds = [...orderMap.keys()];

    // Delete all items for these orders first
    const deletedItems = await tx.orderItem.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    console.log(`\n✓ Deleted ${deletedItems.count} order item(s)`);

    // Delete the orders themselves
    const deletedOrders = await tx.order.deleteMany({
      where: { id: { in: orderIds } },
    });
    console.log(`✓ Deleted ${deletedOrders.count} order(s)`);
  });

  console.log("\n✅ Cleanup complete.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

// node cleanupOrphanOrders.js
//$env:CONFIRM="true"; node cleanupOrphanOrders.js
