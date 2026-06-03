import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient();

// ── Set the product name to delete ───────────────────────────
const PRODUCT_NAME = "Tie"; // ← change this to the product name

async function main() {
  // Find the product
  const product = await prisma.product.findFirst({
    where: { name: { equals: PRODUCT_NAME, mode: "insensitive" } },
    include: {
      inventory: true,
      orderItems: { include: { order: true } },
    },
  });

  if (!product) {
    console.log(`❌ Product "${PRODUCT_NAME}" not found.`);
    return;
  }

  console.log(`\nFound: "${product.name}" (id: ${product.id})`);
  console.log(`  Inventory rows: ${product.inventory.length}`);
  console.log(`  Order items:    ${product.orderItems.length}`);

  // Find unique orders that contain this product
  const orderIds = [...new Set(product.orderItems.map((i) => i.orderId))];
  console.log(`  Orders to delete: ${orderIds.length}`);
  orderIds.forEach((id) => {
    const item = product.orderItems.find((i) => i.orderId === id);
    console.log(`    - ${item.order.orderNumber} (${item.order.status})`);
  });

  // Confirm before deleting
  console.log("\n⚠️  This will permanently delete the above data.");
  console.log("   Set CONFIRM=true to proceed.\n");

  if (process.env.CONFIRM !== "true") {
    console.log("Run with CONFIRM=true to execute the deletion.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    // 1. Delete all order items for this product
    await tx.orderItem.deleteMany({ where: { productId: product.id } });
    console.log("✓ Order items deleted");

    // 2. Delete the orders that now have no items
    //    (only delete orders that belonged entirely to this product)
    for (const orderId of orderIds) {
      const remaining = await tx.orderItem.count({ where: { orderId } });
      if (remaining === 0) {
        await tx.order.delete({ where: { id: orderId } });
        console.log(`✓ Order deleted: ${orderId}`);
      } else {
        console.log(`  Skipped order ${orderId} — has items from other products`);
      }
    }

    // 3. Delete inventory rows
    await tx.inventory.deleteMany({ where: { productId: product.id } });
    console.log("✓ Inventory deleted");

    // 4. Delete the product itself
    await tx.product.delete({ where: { id: product.id } });
    console.log(`✓ Product "${product.name}" deleted`);
  });

  console.log("\n✅ Done.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

//
//Step 1 — Preview what will be deleted (safe, no changes):
 //node deleteProduct.js 
 //Step 2 — Actually delete after confirming the list looks right:
//$env:CONFIRM="true"; node deleteProduct.js