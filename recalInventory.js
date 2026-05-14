import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient();

async function recalcInventory() {
  console.log("Starting inventory recalculation...");

  // 1. Load all inventory rows
  const inventoryRows = await prisma.inventory.findMany();

  // 2. Load all non-cancelled orders with their items
  const orders = await prisma.order.findMany({
    include: { items: true },
  });

  // 3. Build a map: "productId-size" → { reserved, sold }
  const map = {};

  for (const order of orders) {
    const isPending = ["SUBMITTED", "REVIEW"].includes(order.status);
    const isSold = ["PAID", "READY_FOR_PICKUP", "PICKED_UP"].includes(
      order.status,
    );

    const isCancelled = ["CANCELLED"].includes(order.status);
    for (const item of order.items) {
      const key = `${item.productId}-${item.size}`;
      if (!map[key]) map[key] = { reserved: 0, sold: 0 };

      if (isPending) map[key].reserved += item.quantity;
      if (isSold) map[key].sold += item.quantity;
      if (isCancelled) map[key].sold -= item.quantity;
    }
  }

  // 4. Update each inventory row
  let updated = 0;
  for (const inv of inventoryRows) {
    const key = `${inv.productId}-${inv.size}`;
    const stats = map[key] || { reserved: 0, sold: 0 };

    const newReserved = stats.reserved;
    const newSold = stats.sold;
    // Available = Total Stock - Reserved - Sold
    // Total Stock stays as-is (admin manages this manually)
    const newAvailable = inv.totalQty - newReserved;

    await prisma.inventory.update({
      where: { id: inv.id },
      data: {
        reservedQty: newReserved,
        soldQty: newSold,
        // availableQty is calculated on the fly in the API so no need to store it
        // but if your schema has it as a stored field, update it too:
      },
    });

    console.log(
      `Updated ${inv.productId} ${inv.size}: ` +
        `total=${inv.totalQty} reserved=${newReserved} sold=${newSold} available=${newAvailable}`,
    );
    updated++;
  }

  console.log(`\nDone. Updated ${updated} inventory rows.`);
}

recalcInventory()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
