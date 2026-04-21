# 🎒 Wonderworld Uniform Ordering System

A full-stack uniform ordering management app for kindergarten parents and administrators.

---

## 🗂 Project Structure

```
wonderworld/
├── WonderworldApp.jsx      ← React frontend (single-file, all screens)
├── index.html              ← HTML entry point
├── vite.config.js          ← Vite config
├── package.json
├── src/
│   └── main.jsx            ← React DOM entry
├── server/
│   └── index.js            ← Express.js REST API (full backend)
└── prisma/
    └── schema.prisma       ← PostgreSQL schema (all tables, enums, relations)
```

---

## ⚙️ Tech Stack

| Layer       | Technology                          |
|-------------|--------------------------------------|
| Frontend    | React 18 + Vite                     |
| Styling     | CSS-in-JS (inline) + Google Fonts   |
| State       | useReducer + Context API            |
| Backend     | Node.js + Express.js                |
| Database    | PostgreSQL + Prisma ORM             |
| Auth        | JWT (jsonwebtoken) + bcrypt         |
| File Storage| AWS S3 / Cloudflare R2              |
| Realtime    | Socket.IO (for order status sync)   |
| Export      | CSV export (built-in)               |
| Deploy      | Vercel (frontend) + Railway (API+DB)|

---

## 🚀 Frontend Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

Open http://localhost:5173

**Demo accounts (in-app mock data):**
- Parent: `sarah@example.com` / `password123`
- Admin: `wang@wonderworld.edu` / `adminpass`

---

## 🔧 Backend Setup

### 1. Install backend dependencies

```bash
cd server
npm init -y
npm install express cors bcryptjs jsonwebtoken @prisma/client \
            express-async-errors dotenv multer
npm install -D prisma nodemon
```

### 2. Set up environment variables

Create `server/.env`:
```env
DATABASE_URL=postgresql://username:password@localhost:5432/wonderworld
JWT_SECRET=your-super-secret-key-minimum-32-characters
JWT_EXPIRES_IN=7d
FRONTEND_URL=http://localhost:5173
PORT=4000

# Optional: AWS S3 for product image uploads
AWS_REGION=ca-central-1
AWS_BUCKET=wonderworld-uploads
AWS_ACCESS_KEY_ID=your-key-id
AWS_SECRET_ACCESS_KEY=your-secret-key
```

### 3. Set up PostgreSQL

```bash
# Local (macOS with Homebrew)
brew install postgresql@16
brew services start postgresql@16
createdb wonderworld

# Or use a cloud database:
# - Supabase (free tier): https://supabase.com
# - Railway: https://railway.app
# - Neon: https://neon.tech
```

### 4. Run Prisma migrations

```bash
cd server
npx prisma migrate dev --name init
npx prisma generate
npx prisma db push  #sync up with db
```

### 5. Create first admin account

```bash
# Using Prisma Studio
npx prisma studio
# Open http://localhost:5555, add a row to the admins table
# Password must be bcrypt-hashed — use the seed script instead:

node -e "
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  await prisma.admin.create({
    data: {
      name: 'Principal Wang',
      email: 'wang@wonderworld.edu',
      password: await bcrypt.hash('AdminPass123!', 12),
      role: 'SUPER_ADMIN',
    }
  });
  console.log('Admin created!');
  await prisma.\$disconnect();
})();
"
```

### 6. Seed initial settings

```bash
# Start the API server first, then POST to the seed endpoint:
curl -X POST http://localhost:4000/api/admin/seed \
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN"
```

### 7. Start the API server

```bash
cd server
node index.js
# Or with auto-reload:
npx nodemon index.js
```

---

## 📡 API Endpoints

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/parent/register` | — | Register new parent |
| POST | `/api/auth/parent/login` | — | Parent login |
| POST | `/api/auth/admin/login` | — | Admin login |

### Parent (requires parent JWT)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/products` | Active products (no cost price) |
| GET | `/api/locations` | Active school locations |
| GET | `/api/settings` | Public site settings |
| GET | `/api/form-fields` | Visible order form fields |
| POST | `/api/orders` | Submit new order |
| GET | `/api/orders/mine` | Parent's order history |

### Admin (requires admin JWT)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/products` | All products + cost prices |
| POST | `/api/admin/products` | Add product |
| PUT | `/api/admin/products/:id` | Edit product |
| DELETE | `/api/admin/products/:id` | Delete product |
| GET | `/api/admin/inventory` | Full inventory |
| PUT | `/api/admin/inventory/:id` | Update stock |
| GET | `/api/admin/inventory/export` | CSV download |
| GET | `/api/admin/orders` | All orders (search + filter) |
| GET | `/api/admin/orders/:id` | Order detail |
| PUT | `/api/admin/orders/:id/status` | Update status (triggers inventory) |
| GET | `/api/admin/orders/export` | CSV download |
| GET | `/api/admin/stats` | Dashboard stats |
| GET/POST/PUT/DELETE | `/api/admin/locations` | Location CRUD |
| GET/PUT | `/api/admin/settings` | Site settings |
| GET/POST/PUT/DELETE | `/api/admin/form-fields` | Form field config |
| GET/POST/PUT | `/api/admin/accounts` | Admin account management |

---

## 📦 Inventory Logic

```
SUBMITTED  → reservedQty += qty       (soft reserve, prevents overselling)
REVIEW     → (no change, stays reserved)
READY      → totalQty -= qty          (hard deduct from physical stock)
           → reservedQty -= qty
PICKED_UP  → (no change, already deducted at READY)
CANCELLED  → if was SUBMITTED/REVIEW: reservedQty -= qty (release reservation)
           → if was READY/PICKED_UP:  totalQty += qty   (restore to stock)

availableQty = totalQty - reservedQty  (always computed, never stored)
```

---

## 💰 Discount Logic

```
subtotal = sum(unitPrice × quantity) for all items
if subtotal >= discountThreshold (default: $500):
    discountRate = 0.15 (15%)
    discountAmount = subtotal × discountRate
    totalAmount = subtotal - discountAmount
else:
    totalAmount = subtotal
```

Both `discountThreshold` and `discountRate` are configurable in Master Control → Branding.

---

## 🔐 Permission Matrix

| Action | STAFF | MANAGER | SUPER_ADMIN |
|--------|-------|---------|-------------|
| View orders | ✅ | ✅ | ✅ |
| Update order status | ✅ | ✅ | ✅ |
| Add/edit products | ❌ | ✅ | ✅ |
| Delete products | ❌ | ❌ | ✅ |
| Update inventory | ❌ | ✅ | ✅ |
| Manage locations | ❌ | ✅ | ✅ |
| Update site settings | ❌ | ✅ | ✅ |
| Manage admin accounts | ❌ | ❌ | ✅ |

---

## 🔮 Future Expansion

- **Real-time updates**: Add Socket.IO to push order status changes to parents instantly
- **Email notifications**: Nodemailer or SendGrid — trigger on status change
- **Product image uploads**: Multer + AWS S3 presigned URLs
- **Multi-language**: i18next (English + Traditional Chinese for Vancouver families)
- **Inventory alerts**: Cron job to email admins when stock < threshold
- **Excel export**: `exceljs` for formatted XLSX with charts
- **PWA**: Add service worker for offline-capable parent app
- **Barcode scanning**: For pick-up verification (scan order QR → mark Picked Up)
